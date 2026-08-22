import { ethers } from "ethers";
import { MARKETPLACE_ABI } from "./abi.js";
import { rankEligibleListings, stakeConfidenceBps, TOK_SCALE, BPS, NEUTRAL_PRIOR_BPS } from "./scoring.js";
import { analyzeWithAI } from "./ai.js";

const fmtMon = (wei) => `${ethers.formatEther(wei)} MON`;
const fmtTok = (scaled) => (Number(scaled) / 1e6).toFixed(1);
const fmtPct = (bps) => `${(Number(bps) / 100).toFixed(0)}%`;

/**
 * Explicit gas limit for fundJob. Monad charges gas on the *limit*, not on
 * actual usage (see the monad-gas skill), so leaving this to a wallet's
 * estimate risks paying for an inflated limit — especially if an estimate
 * call reverts and the wallet falls back to something huge. fundJob is a
 * bounded, predictable write, so pin it.
 */
const FUND_JOB_GAS_LIMIT = 220_000n;

/** Delay between sequential dashboard events for visual pacing. */
const DASHBOARD_STAGGER_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Autonomous on-chain buyer agent.
 *
 * Signs its own transactions from its own wallet. Given a workload spec and a
 * hard spending cap, it selects a provider, funds a job, watches for
 * settlement, and — if the provider underdelivers and gets slashed — re-routes
 * to the next best provider automatically, with no human in the loop.
 *
 * SAFETY: `maxTotalSpendWei` is checked immediately before every single
 * funding transaction. There is no override path and no way to raise it
 * mid-session. If the next job would breach it, the agent stops.
 */
export class BuyerAgent {
  constructor({ contractAddress, provider, wallet, workload, maxTotalSpendWei, logger = console }) {
    this.contractAddress = contractAddress;
    this.provider = provider;
    this.wallet = wallet;
    this.log = logger;

    this.workload = {
      minTokPerSec: BigInt(workload.minTokPerSec), // already 1e6-scaled
      hours: workload.hours ?? 1,
      maxRetries: workload.maxRetries ?? 2,
      latencySensitive: workload.latencySensitive ?? false,
      minVramGb: workload.minVramGb ?? 0n,
      preferRegion: workload.preferRegion ?? null,
    };

    // Historical average latency per listing, populated in readAllListings()
    // when the workload is latency-sensitive.
    this.latencyByListingId = new Map();

    this.maxTotalSpendWei = BigInt(maxTotalSpendWei);
    this.fundJobGasLimit = FUND_JOB_GAS_LIMIT;
    this.totalSpentWei = 0n;
    this.totalRecoveredWei = 0n;
    this.triedListingIds = new Set();
    this.attempts = [];

    this.contract = new ethers.Contract(contractAddress, MARKETPLACE_ABI, wallet);

    // SSE broadcast function — injected by server.js when running in serve mode.
    // Falls back to a no-op so the agent works identically without the server.
    this.broadcast = () => {};
  }

  /** Emit a structured event to both console and the SSE dashboard. */
  emit(type, data, consoleMsg) {
    if (consoleMsg) this.log.log(consoleMsg);
    this.broadcast(type, {
      ...data,
      totalSpentWei: this.totalSpentWei.toString(),
      totalRecoveredWei: this.totalRecoveredWei.toString(),
      maxTotalSpendWei: this.maxTotalSpendWei.toString(),
      remainingBudgetWei: this.remainingBudgetWei.toString(),
      attemptCount: this.attempts.length,
      maxAttempts: this.workload.maxRetries + 1,
    });
  }

  get remainingBudgetWei() {
    return this.maxTotalSpendWei > this.totalSpentWei ? this.maxTotalSpendWei - this.totalSpentWei : 0n;
  }

  jobCostFor(listing) {
    // Escrow for the requested duration. hours is allowed to be fractional;
    // scale by 1000 to keep it in integer math.
    const milliHours = BigInt(Math.round(this.workload.hours * 1000));
    return (listing.pricePerHour * milliHours) / 1000n;
  }

  /** STEP 1 — read every listing and its reputation from chain. */
  async readAllListings() {
    const nextId = await this.contract.nextListingId();
    const ids = [];
    for (let i = 1n; i < nextId; i += 1n) ids.push(i);

    const entries = await Promise.all(
      ids.map(async (id) => {
        const [listing, reputationBps] = await Promise.all([
          this.contract.getListing(id),
          this.contract.reputationScoreBps(id),
        ]);
        return { id, listing, reputationBps };
      })
    );

    const msg = `\n[READ] ${entries.length} listing(s) found on-chain.`;
    this.emit("read", {
      count: entries.length,
      listings: entries.map((e) => ({
        id: e.id.toString(),
        gpuModel: e.listing.gpuModel,
        claimedTokPerSec: e.listing.claimedTokPerSec.toString(),
        pricePerHour: e.listing.pricePerHour.toString(),
        stake: e.listing.stake.toString(),
        active: e.listing.active,
        totalJobs: e.listing.totalJobs.toString(),
        reputationBps: e.reputationBps.toString(),
      })),
    }, msg);
    // If the workload is latency-sensitive, read historical jobs to compute
    // average latency per listing. This is O(totalJobs) reads per listing —
    // acceptable for a small marketplace.
    if (this.workload.latencySensitive) {
      this.log.log(`[READ] Fetching historical latency data (latency-sensitive workload)…`);
      for (const entry of entries) {
        const { id, listing } = entry;
        if (listing.totalJobs === 0n) continue;
        try {
          // Read all settled jobs for this listing to compute avg latency.
          // In production, this should use an indexer instead of on-chain reads.
          const nextJobId = await this.contract.nextJobId();
          let totalLatency = 0n;
          let count = 0n;
          for (let j = 1n; j < nextJobId; j += 1n) {
            const job = await this.contract.getJob(j);
            if (job.listingId === id && Number(job.status) === 2 && job.measuredLatencyMs > 0n) {
              totalLatency += job.measuredLatencyMs;
              count += 1n;
            }
          }
          if (count > 0n) {
            this.latencyByListingId.set(id.toString(), totalLatency / count);
          }
        } catch {
          // If we can't read historical data, skip — scoring will use neutral latency.
        }
      }
      if (this.latencyByListingId.size > 0) {
        this.log.log(`[READ] Latency data: ${[...this.latencyByListingId.entries()].map(([id, ms]) => `#${id}=${ms}ms`).join(", ")}`);
      }
    }

    return entries;
  }

  /** STEP 2+3 — score, rank, and pick the best listing the agent may fund. */
  selectBest(entries) {
    const ranked = rankEligibleListings({
      listings: entries,
      minTokPerSec: this.workload.minTokPerSec,
      triedListingIds: this.triedListingIds,
      remainingBudgetWei: this.remainingBudgetWei,
      jobCostFor: (l) => this.jobCostFor(l),
      latencySensitive: this.workload.latencySensitive,
      latencyByListingId: this.latencyByListingId,
      minVramGb: this.workload.minVramGb,
      preferRegion: this.workload.preferRegion,
    });

    this.log.log(`[SCORE] ${ranked.length} eligible after filters ` +
      `(min ${fmtTok(this.workload.minTokPerSec)} tok/s, budget left ${fmtMon(this.remainingBudgetWei)}, ` +
      `${this.triedListingIds.size} already tried):`);

    const scoredListings = [];
    for (const r of ranked) {
      const isNew = r.listing.totalJobs === 0n;
      const repLabel = isNew ? `${fmtPct(NEUTRAL_PRIOR_BPS)} (new-provider prior)` : fmtPct(r.reputationBps);
      const stakeConf = stakeConfidenceBps(r.listing.stake, r.listing.pricePerHour);
      const stakeLabel = `stake ${fmtPct(stakeConf)}`;
      const latLabel = this.workload.latencySensitive && this.latencyByListingId.has(r.id.toString())
        ? `lat ${this.latencyByListingId.get(r.id.toString())}ms`
        : "";
      this.log.log(
        `   #${r.id} ${r.listing.gpuModel.padEnd(6)} ` +
          `claim ${fmtTok(r.listing.claimedTokPerSec).padStart(6)} tok/s  ` +
          `${fmtMon(r.listing.pricePerHour).padStart(20)}/hr  ` +
          `rep ${repLabel.padEnd(28)} ` +
          `${stakeLabel.padEnd(14)} ` +
          (latLabel ? `${latLabel.padEnd(12)} ` : "") +
          `adjScore ${r.score.toString()}`
      );
      scoredListings.push({
        id: r.id.toString(),
        gpuModel: r.listing.gpuModel,
        claimedTokPerSec: fmtTok(r.listing.claimedTokPerSec),
        pricePerHour: fmtMon(r.listing.pricePerHour),
        reputationLabel: repLabel,
        stakeLabel,
        latencyLabel: latLabel || null,
        score: r.score.toString(),
        cost: r.cost.toString(),
      });
    }

    this.emit("score", {
      eligibleCount: ranked.length,
      minTokPerSec: fmtTok(this.workload.minTokPerSec),
      triedCount: this.triedListingIds.size,
      listings: scoredListings,
    });

    if (ranked.length === 0) return null;

    const best = ranked[0];
    const selectMsg =
      `[SELECT] Listing #${best.id} (${best.listing.gpuModel}) — best reputation-adjusted cost. ` +
        `Job cost ${fmtMon(best.cost)}.`;
    this.emit("select", {
      listingId: best.id.toString(),
      gpuModel: best.listing.gpuModel,
      score: best.score.toString(),
      cost: fmtMon(best.cost),
      costWei: best.cost.toString(),
      claimedTokPerSec: fmtTok(best.listing.claimedTokPerSec),
    }, selectMsg);
    return best;
  }

  /**
   * STEP 3 (cont.) — fund the job.
   * The spending cap is re-checked here, immediately before signing, so it
   * holds even if state changed between selection and submission.
   */
  async fundJob(candidate) {
    const cost = candidate.cost;

    // ---- HARD GUARDRAIL. No exceptions, no override. ----
    if (this.totalSpentWei + cost > this.maxTotalSpendWei) {
      throw new SpendCapExceeded(
        `Refusing to fund: ${fmtMon(cost)} would push total spend to ` +
          `${fmtMon(this.totalSpentWei + cost)}, over the ${fmtMon(this.maxTotalSpendWei)} cap.`
      );
    }
    // -----------------------------------------------------

    // Wallet must cover the escrow AND the gas the chain will charge. Monad
    // bills the full gas limit, so budget for limit * price, not an estimate.
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const maxGasCost = this.fundJobGasLimit * gasPrice;

    const balance = await this.provider.getBalance(this.wallet.address);
    if (balance < cost + maxGasCost) {
      throw new InsufficientFunds(
        `Wallet holds ${fmtMon(balance)} but the job needs ${fmtMon(cost)} escrow ` +
          `+ up to ${fmtMon(maxGasCost)} gas (${this.fundJobGasLimit} limit @ ${ethers.formatUnits(gasPrice, "gwei")} gwei).`
      );
    }

    this.log.log(`[FUND]   Sending ${fmtMon(cost)} to fundJob(${candidate.id}) (gas limit ${this.fundJobGasLimit})…`);
    this.emit("fund_pending", {
      listingId: candidate.id.toString(),
      cost: fmtMon(cost),
      costWei: cost.toString(),
      gasLimit: this.fundJobGasLimit.toString(),
    });

    const tx = await this.contract.fundJob(candidate.id, {
      value: cost,
      gasLimit: this.fundJobGasLimit,
    });
    const receipt = await tx.wait();

    this.totalSpentWei += cost;
    this.triedListingIds.add(candidate.id.toString());

    const jobId = this.extractJobId(receipt);

    const fundMsg = `[FUND]   tx ${receipt.hash} confirmed in block ${receipt.blockNumber}. Job #${jobId}.`;
    this.emit("fund_confirmed", {
      listingId: candidate.id.toString(),
      jobId: jobId.toString(),
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      cost: fmtMon(cost),
      costWei: cost.toString(),
      explorerUrl: `https://testnet.monadscan.com/tx/${receipt.hash}`,
    }, fundMsg);

    this.log.log(`[SPEND]  Total committed: ${fmtMon(this.totalSpentWei)} / cap ${fmtMon(this.maxTotalSpendWei)}.`);
    this.emit("spend", {
      totalSpent: fmtMon(this.totalSpentWei),
      cap: fmtMon(this.maxTotalSpendWei),
    });

    return { jobId, cost, txHash: receipt.hash };
  }

  extractJobId(receipt) {
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed?.name === "JobFunded") return parsed.args.jobId;
      } catch {
        // not one of ours
      }
    }
    throw new Error("fundJob succeeded but no JobFunded event was found in the receipt.");
  }

  /**
   * STEP 4 — wait for this job to settle.
   * Uses pure polling — Monad's public HTTP RPC doesn't support eth_newFilter,
   * so ethers' contract.on() would crash. The poll interval is tight enough
   * (~2s) that settlement detection feels near-instant for the demo.
   */
  async waitForSettlement(jobId, { timeoutMs = 180_000, pollMs = 2_000 } = {}) {
    this.log.log(`[WATCH]  Waiting for JobSettled on job #${jobId}…`);
    this.emit("watch", { jobId: jobId.toString() });

    const isSettled = (job) => Number(job.status) === 2;

    // Check immediately — the oracle may have already settled it.
    const existing = await this.contract.getJob(jobId);
    if (isSettled(existing)) {
      this.log.log(`[WATCH]  Job #${jobId} had already settled.`);
      return this.describeSettlement(existing);
    }

    return new Promise((resolve, reject) => {
      let finished = false;

      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        clearInterval(poller);
        reject(new SettlementTimeout(`No settlement for job #${jobId} within ${timeoutMs / 1000}s.`));
      }, timeoutMs);

      const poller = setInterval(async () => {
        if (finished) return;
        try {
          const job = await this.contract.getJob(jobId);
          if (isSettled(job)) {
            finished = true;
            clearTimeout(timer);
            clearInterval(poller);
            this.log.log(`[WATCH]  Job #${jobId} settled (detected via poll).`);
            resolve(this.describeSettlement(job));
          }
        } catch {
          // transient read error — try again next tick
        }
      }, pollMs);
    });
  }

  describeSettlement(job) {
    return {
      passed: job.passed,
      measuredTokPerSec: job.measuredTokPerSec,
      measuredSuccessBps: job.measuredSuccessBps,
      slashedAmount: job.slashedAmount,
      escrow: job.escrow,
    };
  }

  /**
   * Main autonomous loop: select -> fund -> watch -> (retry on failure).
   * Never throws for expected terminal conditions; returns a final report.
   */
  async run() {
    this.log.log("=".repeat(72));
    this.log.log("PROVO AUTONOMOUS BUYER AGENT");
    this.log.log(`  wallet:       ${this.wallet.address}`);
    this.log.log(`  contract:     ${this.contractAddress}`);
    this.log.log(`  requires:     >= ${fmtTok(this.workload.minTokPerSec)} tok/s for ${this.workload.hours}h`);
    this.log.log(`  spend cap:    ${fmtMon(this.maxTotalSpendWei)}  (hard, non-overridable)`);
    this.log.log(`  max retries:  ${this.workload.maxRetries}`);
    this.log.log("=".repeat(72));

    this.emit("init", {
      wallet: this.wallet.address,
      contract: this.contractAddress,
      minTokPerSec: fmtTok(this.workload.minTokPerSec),
      hours: this.workload.hours,
      spendCap: fmtMon(this.maxTotalSpendWei),
      maxRetries: this.workload.maxRetries,
    });

    const maxAttempts = this.workload.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.log.log(`\n--- Attempt ${attempt}/${maxAttempts} ---`);
      this.emit("attempt_start", { attempt, maxAttempts });

      let entries;
      try {
        entries = await this.readAllListings();
      } catch (err) {
        return this.finalReport("error", `Could not read listings: ${err.shortMessage || err.message}`);
      }

      // ---- AI REASONING LAYER ----
      // GPT-4 analyzes the listings and explains its recommendation.
      // This runs in parallel with (before) deterministic scoring — the AI
      // provides narrative reasoning while the formula provides the final pick.
      try {
        const aiListings = entries.map((e) => ({
          id: e.id,
          ...e.listing,
          reputationBps: e.reputationBps,
        }));
        await analyzeWithAI(aiListings, {
          minTokPerSec: fmtTok(this.workload.minTokPerSec),
          maxTotalSpendWei: this.maxTotalSpendWei.toString(),
          preferRegion: this.workload.preferRegion,
          minVramGb: this.workload.minVramGb?.toString(),
          latencySensitive: this.workload.latencySensitive,
        }, this.broadcast.bind(this));
      } catch (err) {
        this.log.log(`[AI] Analysis failed (non-fatal): ${err.message}`);
      }
      // ---- END AI LAYER ----

      const candidate = this.selectBest(entries);
      if (!candidate) {
        return this.finalReport(
          "no_eligible_listings",
          `No eligible listing left (needs >= ${fmtTok(this.workload.minTokPerSec)} tok/s, ` +
            `within ${fmtMon(this.remainingBudgetWei)} remaining budget, not already tried).`
        );
      }

      let funded;
      try {
        funded = await this.fundJob(candidate);
      } catch (err) {
        if (err instanceof SpendCapExceeded || err instanceof InsufficientFunds) {
          return this.finalReport("spend_cap_reached", err.message);
        }
        this.log.log(`[ERROR]  Funding listing #${candidate.id} failed: ${err.shortMessage || err.message}`);
        this.triedListingIds.add(candidate.id.toString()); // don't retry a listing that won't accept funds
        continue;
      }

      let outcome;
      try {
        outcome = await this.waitForSettlement(funded.jobId);
      } catch (err) {
        return this.finalReport(
          "settlement_timeout",
          `Job #${funded.jobId} funded (${funded.txHash}) but never settled: ${err.message}`
        );
      }

      this.attempts.push({ listingId: candidate.id, jobId: funded.jobId, ...funded, ...outcome });

      if (outcome.passed) {
        const passMsg =
          `[RESULT] PASS — measured ${fmtTok(outcome.measuredTokPerSec)} tok/s ` +
            `vs claim ${fmtTok(candidate.listing.claimedTokPerSec)} tok/s. Provider paid ${fmtMon(funded.cost)}.`;
        this.emit("result_pass", {
          listingId: candidate.id.toString(),
          jobId: funded.jobId.toString(),
          measuredTokPerSec: fmtTok(outcome.measuredTokPerSec),
          claimedTokPerSec: fmtTok(candidate.listing.claimedTokPerSec),
          cost: fmtMon(funded.cost),
        }, passMsg);
        return this.finalReport("success", `Job #${funded.jobId} passed on listing #${candidate.id}.`);
      }

      // Failed verification: escrow refunded + provider stake slashed to us.
      const recovered = outcome.escrow + outcome.slashedAmount;
      this.totalRecoveredWei += recovered;
      this.totalSpentWei -= outcome.escrow; // refunded, so it no longer counts against the cap

      // ---- STAGGERED EVENTS for dashboard legibility ----
      // These three beats (fail → refund → retry) are the demo's money shot.
      // On-chain settlement already happened instantly, but the audience needs
      // time to read each card before the next one appears.

      const failMsg =
        `[RESULT] FAIL — measured ${fmtTok(outcome.measuredTokPerSec)} tok/s ` +
          `vs claim ${fmtTok(candidate.listing.claimedTokPerSec)} tok/s.`;
      this.emit("result_fail", {
        listingId: candidate.id.toString(),
        jobId: funded.jobId.toString(),
        measuredTokPerSec: fmtTok(outcome.measuredTokPerSec),
        claimedTokPerSec: fmtTok(candidate.listing.claimedTokPerSec),
        gpuModel: candidate.listing.gpuModel,
      }, failMsg);

      await sleep(DASHBOARD_STAGGER_MS);

      const refundMsg =
        `[REFUND] Escrow ${fmtMon(outcome.escrow)} refunded + ${fmtMon(outcome.slashedAmount)} slashed ` +
          `from provider stake = ${fmtMon(recovered)} recovered.`;
      this.emit("refund", {
        escrow: fmtMon(outcome.escrow),
        slashedAmount: fmtMon(outcome.slashedAmount),
        totalRecovered: fmtMon(recovered),
        listingId: candidate.id.toString(),
      }, refundMsg);

      await sleep(DASHBOARD_STAGGER_MS);

      if (attempt < maxAttempts) {
        const retryMsg =
          `[RETRY]  Autonomous re-route: listing #${candidate.id} is now excluded; ` +
            `re-scoring remaining providers with ${fmtMon(this.remainingBudgetWei)} budget. No human approval required.`;
        this.emit("retry", {
          excludedListingId: candidate.id.toString(),
          remainingBudget: fmtMon(this.remainingBudgetWei),
          nextAttempt: attempt + 1,
          maxAttempts,
        }, retryMsg);
      }
    }

    return this.finalReport(
      "retries_exhausted",
      `All ${maxAttempts} attempt(s) failed verification. Every funded job was refunded and compensated.`
    );
  }

  finalReport(status, message) {
    const netWei = this.totalRecoveredWei - this.attempts.filter((a) => a.passed).reduce((s, a) => s + a.cost, 0n);

    this.log.log(`\n${"=".repeat(72)}`);
    this.log.log(`FINAL REPORT — ${status.toUpperCase()}`);
    this.log.log(`  ${message}`);
    this.log.log(`  attempts made:      ${this.attempts.length}`);
    for (const a of this.attempts) {
      this.log.log(
        `    - listing #${a.listingId} job #${a.jobId}: ${a.passed ? "PASS" : "FAIL"} ` +
          `(measured ${fmtTok(a.measuredTokPerSec)} tok/s)` +
          (a.passed ? `, paid ${fmtMon(a.cost)}` : `, recovered ${fmtMon(a.escrow + a.slashedAmount)}`)
      );
    }
    this.log.log(`  net committed:      ${fmtMon(this.totalSpentWei)} of ${fmtMon(this.maxTotalSpendWei)} cap`);
    this.log.log(`  recovered on fails: ${fmtMon(this.totalRecoveredWei)}`);
    this.log.log(`  net position:       ${netWei >= 0n ? "+" : ""}${fmtMon(netWei)}`);
    this.log.log("=".repeat(72));

    this.emit("report", {
      status,
      message,
      success: status === "success",
      attemptsMade: this.attempts.length,
      attempts: this.attempts.map((a) => ({
        listingId: a.listingId?.toString(),
        jobId: a.jobId?.toString(),
        passed: a.passed,
        measuredTokPerSec: fmtTok(a.measuredTokPerSec),
        cost: a.cost ? fmtMon(a.cost) : "0",
        recovered: !a.passed && a.escrow != null ? fmtMon(a.escrow + a.slashedAmount) : "0",
      })),
      netCommitted: fmtMon(this.totalSpentWei),
      recovered: fmtMon(this.totalRecoveredWei),
      netPosition: `${netWei >= 0n ? "+" : ""}${fmtMon(netWei)}`,
    });

    return {
      status,
      message,
      attempts: this.attempts,
      totalSpentWei: this.totalSpentWei,
      totalRecoveredWei: this.totalRecoveredWei,
      success: status === "success",
    };
  }
}

export class SpendCapExceeded extends Error {}
export class InsufficientFunds extends Error {}
export class SettlementTimeout extends Error {}

export { TOK_SCALE, BPS };
