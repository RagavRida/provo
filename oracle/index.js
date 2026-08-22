#!/usr/bin/env node
/**
 * Provo oracle bridge.
 *
 * Minimal single-signer service: takes a benchmark-agent-shaped payload
 * (jobId, measuredTokPerSec, measuredLatencyMs, measuredSuccessBps) and
 * calls submitVerification on the deployed ProvoMarketplace contract on
 * Monad testnet.
 *
 * Hackathon scope: one trusted oracle private key, no multi-party consensus.
 * v2/roadmap: replace with a decentralized oracle network + dispute window
 * (see ProvoMarketplace.sol comments).
 *
 * Usage:
 *   node index.js --jobId 3 --tokPerSec 90650000 --latencyMs 793 --successBps 6667
 *   node index.js --payload ./payload.json
 */

import { readFile } from "node:fs/promises";
import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PROVO_MARKETPLACE_ABI } from "./abi.js";

// Confirm chainId/RPC against https://docs.monad.xyz — testnet endpoints rotate.
const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz"] },
  },
});

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

async function loadPayload(args) {
  if (args.payload) {
    const raw = await readFile(args.payload, "utf8");
    return JSON.parse(raw);
  }
  if (!args.jobId || args.tokPerSec === undefined || args.latencyMs === undefined || args.successBps === undefined) {
    throw new Error(
      "Provide either --payload <file.json> or all of --jobId --tokPerSec --latencyMs --successBps.\n" +
        "tokPerSec/latencyMs/successBps should be the exact scaled integers from the benchmark agent's oracle payload."
    );
  }
  return {
    jobId: args.jobId,
    measuredTokPerSec: args.tokPerSec,
    measuredLatencyMs: args.latencyMs,
    measuredSuccessBps: args.successBps,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = await loadPayload(args);

  const oraclePrivateKey = process.env.ORACLE_PRIVATE_KEY;
  const contractAddress = process.env.CONTRACT_ADDRESS;

  if (!oraclePrivateKey) throw new Error("Set ORACLE_PRIVATE_KEY in the environment.");
  if (!contractAddress) throw new Error("Set CONTRACT_ADDRESS in the environment.");

  const account = privateKeyToAccount(oraclePrivateKey);

  const publicClient = createPublicClient({ chain: monadTestnet, transport: http() });
  const walletClient = createWalletClient({ account, chain: monadTestnet, transport: http() });

  console.log(`Oracle signer: ${account.address}`);
  console.log(`Contract: ${contractAddress}`);
  console.log(`Submitting verification for job ${payload.jobId}:`, payload);

  const { request } = await publicClient.simulateContract({
    address: contractAddress,
    abi: PROVO_MARKETPLACE_ABI,
    functionName: "submitVerification",
    args: [
      BigInt(payload.jobId),
      BigInt(payload.measuredTokPerSec),
      BigInt(payload.measuredLatencyMs),
      BigInt(payload.measuredSuccessBps),
    ],
    account,
  });

  const hash = await walletClient.writeContract(request);
  console.log(`Submitted. Tx hash: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Confirmed in block ${receipt.blockNumber}. Status: ${receipt.status}`);

  const settled = receipt.logs.length > 0;
  console.log(
    settled
      ? "Job settled — check the JobSettled event on the explorer for pass/fail + payout/slash amounts."
      : "No logs returned — check the transaction on the explorer."
  );
}

main().catch((err) => {
  console.error("Oracle bridge failed:", err.shortMessage || err.message || err);
  process.exitCode = 1;
});
