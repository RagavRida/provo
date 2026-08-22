#!/usr/bin/env node
/**
 * Auto-settling oracle watcher for Provo marketplace.
 *
 * Modes:
 *   --policy (default)    Use a static policy mapping listingId -> measured result.
 *                         Deterministic; ideal for demos and testing.
 *   --benchmark-mode      Actually hit provider inference endpoints and measure
 *                         real tok/s, latency, and success rate. Requires an
 *                         endpoints registry (--endpoints ./endpoints.json).
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... ORACLE_PRIVATE_KEY=0x... node watch.js
 *   node watch.js --benchmark-mode --endpoints ./endpoints.json
 *   node watch.js --policy ./demo-policy.json --once
 *
 * Env: RPC_URL, CONTRACT_ADDRESS, ORACLE_PRIVATE_KEY
 */

import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, defineChain, formatEther, formatGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PROVO_MARKETPLACE_ABI } from "./abi.js";
import { benchmark } from "./benchmark.js";

// Confirm chainId/RPC against https://docs.monad.xyz — testnet endpoints rotate.
const monadTestnet = defineChain({
  id: Number(process.env.CHAIN_ID || 10143),
  name: process.env.CHAIN_ID && process.env.CHAIN_ID !== "10143" ? "Local Chain" : "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://testnet-rpc.monad.xyz"] } },
});

// Monad charges gas on the LIMIT, not usage (see the monad-gas skill).
const VERIFY_GAS = 320_000n;
const JOB_STATUS_FUNDED = 1;
const TOLERANCE_BPS = 9500n;
const BPS = 10_000n;

const fmtTok = (scaled) => (Number(scaled) / 1e6).toFixed(1);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------
// Policy mode — static, deterministic results
// -------------------------------------------------------------------------

const DEFAULT_POLICY = {
  1: { tokPerSec: 60, latencyMs: 1200, successBps: 9200 },
  2: { tokPerSec: 96, latencyMs: 760, successBps: 10000 },
  3: { tokPerSec: 58, latencyMs: 1400, successBps: 9000 },
};

async function loadPolicy(args) {
  if (!args.policy || args.policy === true) return DEFAULT_POLICY;
  return JSON.parse(await readFile(args.policy, "utf8"));
}

function policyMeasure(policy, listingId) {
  const rule = policy[listingId.toString()];
  if (!rule) return null;
  return {
    tokPerSec: rule.tokPerSec,
    latencyMs: rule.latencyMs,
    successBps: rule.successBps,
  };
}

// -------------------------------------------------------------------------
// Benchmark mode — real inference measurement
// -------------------------------------------------------------------------

async function loadEndpoints(args) {
  const path = args.endpoints || "./endpoints.json";
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    console.error(`[FATAL] Could not load endpoints from ${path}: ${err.message}`);
    process.exit(1);
  }
}

async function benchmarkMeasure(endpoints, listingId) {
  const entry = endpoints[listingId.toString()];
  if (!entry || !entry.url) return null;
  try {
    return await benchmark(entry.url, { runs: 3 });
  } catch (err) {
    console.warn(`  [benchmark] Error for listing #${listingId}: ${err.message}`);
    return null;
  }
}

// -------------------------------------------------------------------------
// Main loop
// -------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const useBenchmark = !!args["benchmark-mode"];

  let policy = null;
  let endpoints = null;

  if (useBenchmark) {
    endpoints = await loadEndpoints(args);
    console.log("Provo oracle watcher (BENCHMARK MODE)");
    console.log(`  endpoints: ${Object.keys(endpoints).length} registered`);
  } else {
    policy = await loadPolicy(args);
    console.log("Provo oracle watcher (POLICY MODE)");
    console.log(
      `  policy:   ${Object.entries(policy).map(([k, v]) => `listing#${k}->${v.tokPerSec}tok/s`).join(", ")}`
    );
  }

  const contractAddress = process.env.CONTRACT_ADDRESS;
  const oracleKey = process.env.ORACLE_PRIVATE_KEY;
  if (!contractAddress) throw new Error("Set CONTRACT_ADDRESS.");
  if (!oracleKey) throw new Error("Set ORACLE_PRIVATE_KEY (must match the contract's configured oracle).");

  const account = privateKeyToAccount(oracleKey);
  const transport = http(process.env.RPC_URL || undefined);
  const publicClient = createPublicClient({ chain: monadTestnet, transport });
  const walletClient = createWalletClient({ account, chain: monadTestnet, transport });

  const read = (functionName, fnArgs = []) =>
    publicClient.readContract({ address: contractAddress, abi: PROVO_MARKETPLACE_ABI, functionName, args: fnArgs });

  console.log(`  signer:   ${account.address}`);
  console.log(`  contract: ${contractAddress}`);
  const bal = await publicClient.getBalance({ address: account.address });
  const gasPrice = await publicClient.getGasPrice().catch(() => 0n);
  console.log(`  balance:  ${formatEther(bal)} MON`);
  console.log(`  gas:      ${VERIFY_GAS} limit @ ${formatGwei(gasPrice)} gwei = up to ${formatEther(VERIFY_GAS * gasPrice)} MON/settle`);
  console.log("\nWatching for funded jobs… (Ctrl-C to stop)\n");

  const handled = new Set();
  let stopping = false;
  process.on("SIGINT", () => {
    console.log("\nStopping…");
    stopping = true;
  });

  while (!stopping) {
    try {
      const nextJobId = await read("nextJobId");

      for (let id = 1n; id < nextJobId && !stopping; id += 1n) {
        const key = id.toString();
        if (handled.has(key)) continue;

        const job = await read("getJob", [id]);
        if (Number(job.status) !== JOB_STATUS_FUNDED) {
          handled.add(key);
          continue;
        }

        // Get measurement — either from policy or real benchmark
        let measured;
        if (useBenchmark) {
          console.log(`  job #${id} (listing #${job.listingId}): benchmarking…`);
          measured = await benchmarkMeasure(endpoints, job.listingId);
        } else {
          measured = policyMeasure(policy, job.listingId);
        }

        if (!measured) {
          console.log(`  job #${id} on listing #${job.listingId}: no ${useBenchmark ? "endpoint" : "policy entry"}, skipping`);
          handled.add(key);
          continue;
        }

        const listing = await read("getListing", [job.listingId]);
        const scaled = BigInt(Math.round(measured.tokPerSec * 1e6));
        const verdict = scaled >= (listing.claimedTokPerSec * TOLERANCE_BPS) / BPS ? "PASS" : "FAIL";

        console.log(
          `  job #${id} (listing #${job.listingId}): measured ${measured.tokPerSec.toFixed(1)} tok/s ` +
            `(${measured.latencyMs}ms lat, ${(measured.successBps / 100).toFixed(0)}% success) ` +
            `vs claim ${fmtTok(listing.claimedTokPerSec)} -> expect ${verdict}`
        );

        handled.add(key);

        const hash = await walletClient.writeContract({
          address: contractAddress,
          abi: PROVO_MARKETPLACE_ABI,
          functionName: "submitVerification",
          args: [id, scaled, BigInt(measured.latencyMs), BigInt(measured.successBps)],
          gas: VERIFY_GAS,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log(`     settled in block ${receipt.blockNumber} — tx ${receipt.transactionHash}`);
      }
    } catch (err) {
      console.error(`  [warn] ${err.shortMessage || err.message}`);
    }

    if (args.once) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((err) => {
  console.error(`\n[FATAL] ${err.shortMessage || err.message}`);
  process.exitCode = 1;
});
