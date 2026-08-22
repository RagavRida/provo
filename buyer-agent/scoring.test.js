import assert from "node:assert/strict";
import {
  scoreListing,
  effectiveReputationBps,
  stakeConfidenceBps,
  latencyPenaltyBps,
  rankEligibleListings,
  NEUTRAL_PRIOR_BPS,
  MIN_REP_BPS,
  STAKE_CONFIDENCE_FLOOR_BPS,
  REGION_MATCH_BONUS_BPS,
  BPS,
  LATENCY_BASELINE_MS,
} from "./scoring.js";

const ETH = (n) => BigInt(Math.round(n * 1e18));
const TOK = (n) => BigInt(Math.round(n * 1e6));

function listing(overrides = {}) {
  return {
    provider: "0x1",
    gpuModel: "H100",
    vramGb: 80n,
    region: "us-east",
    claimedTokPerSec: TOK(95),
    pricePerHour: ETH(0.018),
    stake: ETH(0.018), // 1x hourly rate = 100% confidence by default
    active: true,
    passedJobs: 10n,
    totalJobs: 10n,
    ...overrides,
  };
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✔ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✘ ${name}\n    ${err.message}`);
    failed += 1;
    process.exitCode = 1;
  }
}

// =========================================================================
// Reputation (unchanged from v1)
// =========================================================================
console.log("\nreputation");

test("new provider (no history) gets the neutral 75% prior, not exclusion", () => {
  const l = listing({ passedJobs: 0n, totalJobs: 0n });
  assert.equal(effectiveReputationBps(l, 0n), NEUTRAL_PRIOR_BPS);
});

test("established provider uses its real on-chain reputation", () => {
  const l = listing({ passedJobs: 8n, totalJobs: 10n });
  assert.equal(effectiveReputationBps(l, 8000n), 8000n);
});

test("0%-reputation provider is floored, not divided-by-zero", () => {
  const l = listing({ passedJobs: 0n, totalJobs: 5n });
  assert.equal(effectiveReputationBps(l, 0n), MIN_REP_BPS);
  assert.ok(scoreListing(l, 0n) > 0n);
});

// =========================================================================
// Stake confidence (v2)
// =========================================================================
console.log("\nstake confidence");

test("provider staking >= 1x hourly rate gets full confidence (BPS)", () => {
  assert.equal(stakeConfidenceBps(ETH(0.02), ETH(0.018)), BPS);
  assert.equal(stakeConfidenceBps(ETH(1.0), ETH(0.018)), BPS); // 55x — still capped
});

test("provider staking 0.5x hourly rate gets 50% confidence", () => {
  assert.equal(stakeConfidenceBps(ETH(0.009), ETH(0.018)), 5000n);
});

test("provider staking below floor gets the floor (no divide-by-zero)", () => {
  assert.equal(stakeConfidenceBps(ETH(0.001), ETH(0.018)), STAKE_CONFIDENCE_FLOOR_BPS);
  assert.equal(stakeConfidenceBps(0n, ETH(0.018)), STAKE_CONFIDENCE_FLOOR_BPS);
});

test("free listing (pricePerHour = 0) gets full confidence (stake irrelevant)", () => {
  assert.equal(stakeConfidenceBps(ETH(0.05), 0n), BPS);
});

test("high-stake provider beats low-stake at equal price/throughput/reputation", () => {
  const highStake = scoreListing(listing({ stake: ETH(0.1) }), 10000n);
  const lowStake = scoreListing(listing({ stake: ETH(0.002) }), 10000n);
  assert.ok(highStake < lowStake, "higher stake should produce a lower (better) score");
});

test("both reputation and stake contribute — moderate values show interaction", () => {
  // 80% rep + 50% stake confidence = 1.25 * 2.0 = 2.5x penalty
  const modRepModStake = scoreListing(listing({ stake: ETH(0.009) }), 8000n);
  // 100% rep + 100% stake confidence = 1.0 * 1.0 = 1x (best)
  const perfectBoth = scoreListing(listing({ stake: ETH(0.02) }), 10000n);
  // 50% rep + 100% stake confidence = 2.0 * 1.0 = 2x penalty
  const badRepGoodStake = scoreListing(listing({ stake: ETH(0.02) }), 5000n);

  assert.ok(perfectBoth < modRepModStake, "perfect both should beat moderate both");
  assert.ok(perfectBoth < badRepGoodStake, "perfect both should beat bad rep");
  assert.ok(badRepGoodStake < modRepModStake, "2x penalty should beat 2.5x penalty");
});

// =========================================================================
// Latency penalty (v2)
// =========================================================================
console.log("\nlatency penalty");

test("at or below baseline (100ms), no penalty", () => {
  assert.equal(latencyPenaltyBps(100n), BPS);
  assert.equal(latencyPenaltyBps(50n), BPS);
  assert.equal(latencyPenaltyBps(0n), BPS);
});

test("null/undefined latency returns neutral (BPS)", () => {
  assert.equal(latencyPenaltyBps(null), BPS);
  assert.equal(latencyPenaltyBps(undefined), BPS);
});

test("200ms above baseline doubles the penalty", () => {
  // baseline=100, scale=200. At 300ms: penalty = BPS + (200 * BPS / 200) = 2 * BPS
  assert.equal(latencyPenaltyBps(300n), BPS * 2n);
});

test("penalty scales linearly above baseline", () => {
  const p150 = latencyPenaltyBps(150n); // 50ms over -> 0.25x penalty
  const p200 = latencyPenaltyBps(200n); // 100ms over -> 0.5x penalty
  const p400 = latencyPenaltyBps(400n); // 300ms over -> 1.5x penalty
  assert.ok(p150 < p200);
  assert.ok(p200 < p400);
});

test("latency-sensitive scoring: fast provider beats slow at equal price/throughput", () => {
  const fast = scoreListing(listing(), 10000n, { latencySensitive: true, avgLatencyMs: 50n });
  const slow = scoreListing(listing(), 10000n, { latencySensitive: true, avgLatencyMs: 400n });
  assert.ok(fast < slow, "50ms provider should score better than 400ms");
});

test("latency is ignored when latencySensitive is false", () => {
  const withLatency = scoreListing(listing(), 10000n, { latencySensitive: false, avgLatencyMs: 500n });
  const withoutLatency = scoreListing(listing(), 10000n);
  assert.equal(withLatency, withoutLatency, "latency should have no effect when not sensitive");
});

// =========================================================================
// Base scoring (v1 tests, must still pass)
// =========================================================================
console.log("\nbase scoring");

test("lower price at equal throughput scores better", () => {
  const cheap = scoreListing(listing({ pricePerHour: ETH(0.01) }), 10000n);
  const pricey = scoreListing(listing({ pricePerHour: ETH(0.02) }), 10000n);
  assert.ok(cheap < pricey);
});

test("higher throughput at equal price scores better", () => {
  const fast = scoreListing(listing({ claimedTokPerSec: TOK(120) }), 10000n);
  const slow = scoreListing(listing({ claimedTokPerSec: TOK(60) }), 10000n);
  assert.ok(fast < slow);
});

test("worse reputation penalises an otherwise identical listing", () => {
  const good = scoreListing(listing(), 10000n);
  const bad = scoreListing(listing(), 5000n);
  assert.ok(bad > good, "50% reputation should score worse");
});

test("a cheap-but-unreliable provider loses to a pricier reliable one", () => {
  const cheapFlaky = scoreListing(listing({ pricePerHour: ETH(0.010) }), 4000n);
  const pricierSolid = scoreListing(listing({ pricePerHour: ETH(0.018) }), 10000n);
  assert.ok(pricierSolid < cheapFlaky, "reputation penalty should outweigh the sticker discount here");
});

// =========================================================================
// rankEligibleListings
// =========================================================================
console.log("\nrankEligibleListings");

const jobCostFor = (l) => l.pricePerHour; // 1 hour

test("filters out inactive listings", () => {
  const ranked = rankEligibleListings({
    listings: [{ id: 1n, listing: listing({ active: false }), reputationBps: 10000n }],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
  });
  assert.equal(ranked.length, 0);
});

test("filters out listings below the workload's minimum throughput", () => {
  const ranked = rankEligibleListings({
    listings: [{ id: 1n, listing: listing({ claimedTokPerSec: TOK(40) }), reputationBps: 10000n }],
    minTokPerSec: TOK(90),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
  });
  assert.equal(ranked.length, 0);
});

test("never re-offers a listing already tried this session", () => {
  const ranked = rankEligibleListings({
    listings: [{ id: 7n, listing: listing(), reputationBps: 10000n }],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(["7"]),
    remainingBudgetWei: ETH(1),
    jobCostFor,
  });
  assert.equal(ranked.length, 0);
});

test("filters out listings that would breach the remaining budget", () => {
  const ranked = rankEligibleListings({
    listings: [{ id: 1n, listing: listing({ pricePerHour: ETH(0.5) }), reputationBps: 10000n }],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(0.1),
    jobCostFor,
  });
  assert.equal(ranked.length, 0, "0.5 MON job must not be offered against a 0.1 MON remaining budget");
});

test("ranks best reputation-adjusted cost first", () => {
  const ranked = rankEligibleListings({
    listings: [
      { id: 1n, listing: listing({ pricePerHour: ETH(0.015), claimedTokPerSec: TOK(61) }), reputationBps: 10000n },
      { id: 2n, listing: listing({ pricePerHour: ETH(0.018), claimedTokPerSec: TOK(95) }), reputationBps: 10000n },
      { id: 3n, listing: listing({ pricePerHour: ETH(0.021), claimedTokPerSec: TOK(84) }), reputationBps: 6700n },
    ],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
  });
  assert.equal(ranked[0].id, 2n, "the 95 tok/s @ 0.018 listing is cheapest per delivered tok/s");
  assert.equal(ranked.length, 3);
});

test("stake-to-claim ratio breaks ties between otherwise equal listings", () => {
  const ranked = rankEligibleListings({
    listings: [
      { id: 1n, listing: listing({ stake: ETH(0.002) }), reputationBps: 10000n },  // low stake
      { id: 2n, listing: listing({ stake: ETH(0.05) }), reputationBps: 10000n },   // high stake
    ],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
  });
  assert.equal(ranked[0].id, 2n, "higher stake should rank first when all else is equal");
});

test("latency data is used when latencySensitive = true", () => {
  const latencyMap = new Map([["1", 50n], ["2", 400n]]);
  const ranked = rankEligibleListings({
    listings: [
      { id: 1n, listing: listing(), reputationBps: 10000n },
      { id: 2n, listing: listing(), reputationBps: 10000n },
    ],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
    latencySensitive: true,
    latencyByListingId: latencyMap,
  });
  assert.equal(ranked[0].id, 1n, "50ms listing should rank above 400ms listing");
});

test("latency data is ignored when latencySensitive = false", () => {
  const latencyMap = new Map([["1", 500n], ["2", 50n]]);
  const ranked = rankEligibleListings({
    listings: [
      { id: 1n, listing: listing(), reputationBps: 10000n },
      { id: 2n, listing: listing(), reputationBps: 10000n },
    ],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
    latencySensitive: false,
    latencyByListingId: latencyMap,
  });
  assert.equal(ranked[0].id, 1n, "latency should not affect ranking when not sensitive");
});

// =========================================================================
// VRAM hard filter (v2)
// =========================================================================
console.log("\nVRAM filter");

test("filters out listings below minVramGb", () => {
  const ranked = rankEligibleListings({
    listings: [
      { id: 1n, listing: listing({ vramGb: 40n }), reputationBps: 10000n },
      { id: 2n, listing: listing({ vramGb: 80n }), reputationBps: 10000n },
    ],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
    minVramGb: 80n,
  });
  assert.equal(ranked.length, 1, "40GB listing should be filtered out");
  assert.equal(ranked[0].id, 2n);
});

test("passes listings that meet minVramGb", () => {
  const ranked = rankEligibleListings({
    listings: [
      { id: 1n, listing: listing({ vramGb: 80n }), reputationBps: 10000n },
    ],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
    minVramGb: 40n,
  });
  assert.equal(ranked.length, 1);
});

// =========================================================================
// Region preference (v2)
// =========================================================================
console.log("\nRegion preference");

test("same-region listing gets a scoring boost", () => {
  const ranked = rankEligibleListings({
    listings: [
      { id: 1n, listing: listing({ region: "eu-west" }), reputationBps: 10000n },
      { id: 2n, listing: listing({ region: "us-east" }), reputationBps: 10000n },
    ],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
    preferRegion: "us-east",
  });
  assert.equal(ranked[0].id, 2n, "us-east listing should rank first when preferRegion=us-east");
});

test("cross-region listings are still eligible (soft, not hard filter)", () => {
  const ranked = rankEligibleListings({
    listings: [
      { id: 1n, listing: listing({ region: "asia-southeast" }), reputationBps: 10000n },
    ],
    minTokPerSec: TOK(50),
    triedListingIds: new Set(),
    remainingBudgetWei: ETH(1),
    jobCostFor,
    preferRegion: "us-east",
  });
  assert.equal(ranked.length, 1, "cross-region listing should still be eligible");
});

console.log(`\n${passed} passing${failed ? `, ${failed} failing` : ""}\n`);
