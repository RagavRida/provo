#!/usr/bin/env node
/**
 * CLI entrypoint for the Provo autonomous buyer agent.
 *
 * Fund the agent's wallet once, hand it a workload spec, and it runs the whole
 * shop -> pay -> verify -> re-route loop on its own.
 *
 * Env:
 *   RPC_URL              Monad testnet RPC (default: https://testnet-rpc.monad.xyz)
 *   CONTRACT_ADDRESS     deployed marketplace address (required)
 *   AGENT_PRIVATE_KEY    the agent's own key — it signs its own txs (required)
 *   AGENT_PORT           SSE server port when using --serve (default: 3001)
 *
 *   --min-tok-s <n>      minimum acceptable throughput, tok/s      (default 90)
 *   --hours <n>          hours of compute to fund per job          (default 1)
 *   --max-retries <n>    automatic re-routes after a failure       (default 2)
 *   --max-spend <mon>    HARD total spend cap, in MON              (default 0.05)
 *   --latency-sensitive  enable latency-weighted scoring (reads historical job data)
 *   --min-vram <gb>      minimum GPU VRAM in GB (hard filter)      (default: no filter)
 *   --prefer-region <r>  preferred region for soft scoring boost   (default: no preference)
 *   --serve              Start SSE server and wait for POST /start from the dashboard
 */

import { ethers } from "ethers";
import { BuyerAgent } from "./agent.js";
import { createAgentServer } from "./server.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
        continue;
      }
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rpcUrl = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const privateKey = process.env.AGENT_PRIVATE_KEY;

  if (!contractAddress) throw new Error("Set CONTRACT_ADDRESS to the deployed marketplace address.");
  if (!privateKey) throw new Error("Set AGENT_PRIVATE_KEY to the agent's own wallet key.");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const agent = new BuyerAgent({
    contractAddress,
    provider,
    wallet,
    workload: {
      // CLI takes human tok/s; contract stores it scaled by 1e6.
      minTokPerSec: BigInt(Math.round(Number(args["min-tok-s"] ?? 90) * 1e6)),
      hours: Number(args.hours ?? 1),
      maxRetries: Number(args["max-retries"] ?? 2),
      latencySensitive: !!args["latency-sensitive"],
      minVramGb: args["min-vram"] ? BigInt(Number(args["min-vram"])) : 0n,
      preferRegion: args["prefer-region"] || null,
    },
    maxTotalSpendWei: ethers.parseEther(String(args["max-spend"] ?? "0.05")),
  });

  if (args.serve) {
    // Dashboard mode: start SSE server and wait for POST /start from the frontend.
    const port = Number(process.env.AGENT_PORT || 3001);
    const srv = createAgentServer(agent, { port });
    await srv.listen();
    console.log("\nWaiting for POST /start from the dashboard (http://localhost:5173/agent)…\n");
    // Server keeps the process alive. agent.run() is triggered by POST /start.
  } else {
    // Headless CLI mode: run immediately.
    const report = await agent.run();
    process.exitCode = report.success ? 0 : 1;
  }
}

main().catch((err) => {
  // Terminal conditions are handled inside run() and reported cleanly; this
  // only catches setup/config problems.
  console.error(`\n[FATAL] ${err.shortMessage || err.message}`);
  process.exitCode = 1;
});
