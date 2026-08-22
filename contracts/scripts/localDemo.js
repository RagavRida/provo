/**
 * End-to-end local demo harness for the autonomous buyer agent.
 *
 * Spins up the full Provo scenario on a local Hardhat node:
 *   - deploys the marketplace
 *   - seeds three listings (one too-good-to-be-true, one solid, one too slow)
 *   - funds the agent's wallet
 *   - launches the autonomous buyer agent as a separate process
 *   - plays the oracle: watches for JobFunded and submits a verification that
 *     makes the first provider FAIL (triggering a slash + auto-reroute) and the
 *     second provider PASS
 *
 * Run with a `npx hardhat node` already running in another terminal:
 *   npx hardhat run scripts/localDemo.js --network localhost
 */

const hre = require("hardhat");
const { spawn } = require("child_process");
const path = require("path");

const TOK = (n) => BigInt(Math.round(n * 1e6));
const ETH = (n) => hre.ethers.parseEther(String(n));

// Agent's own wallet — a well-known Hardhat test key. LOCAL DEMO ONLY.
const AGENT_PRIVATE_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

async function main() {
  const [deployer, oracle, providerA, providerB, providerC] = await hre.ethers.getSigners();
  const agentWallet = new hre.ethers.Wallet(AGENT_PRIVATE_KEY, hre.ethers.provider);

  console.log("Deploying marketplace…");
  const Factory = await hre.ethers.getContractFactory("ProvoMarketplace", deployer);
  const market = await Factory.deploy(oracle.address);
  await market.waitForDeployment();
  const address = await market.getAddress();
  console.log(`  deployed at ${address}`);
  console.log(`  oracle:     ${oracle.address}`);

  // Seed listings.
  //  #1 "too good to be true": best headline score, will underdeliver badly.
  //  #2 solid: slightly pricier per hour, actually delivers.
  //  #3 too slow: filtered out by the workload's minimum throughput.
  console.log("\nSeeding listings…");
  await (await market.connect(providerA).createListing("H100", 80, "us-east", TOK(100), ETH("0.010"), { value: ETH("1.0") })).wait();
  console.log("  #1 H100  claims 100.0 tok/s @ 0.010 MON/hr  (stake 1.0 MON)  <- headline-best");
  await (await market.connect(providerB).createListing("H100", 80, "eu-west", TOK(95), ETH("0.014"), { value: ETH("1.0") })).wait();
  console.log("  #2 H100  claims  95.0 tok/s @ 0.014 MON/hr  (stake 1.0 MON)  <- honest");
  await (await market.connect(providerC).createListing("A100", 40, "us-east", TOK(60), ETH("0.009"), { value: ETH("1.0") })).wait();
  console.log("  #3 A100  claims  60.0 tok/s @ 0.009 MON/hr  (stake 1.0 MON)  <- below workload minimum");

  // Fund the agent's wallet once — this is the only human action in the demo.
  console.log("\nFunding the agent's wallet with 0.5 MON (the one human action)…");
  await (await deployer.sendTransaction({ to: agentWallet.address, value: ETH("0.5") })).wait();
  console.log(`  agent wallet ${agentWallet.address} = ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(agentWallet.address))} MON`);

  // Oracle: react to each JobFunded with a verification result.
  // Listing #1 underdelivers (60 vs 100 claimed) -> FAIL + slash.
  // Listing #2 delivers (96 vs 95 claimed)       -> PASS.
  const measuredFor = {
    1: { tok: TOK(60), latency: 1200, successBps: 9200, label: "60.0 tok/s (claimed 100.0) -> FAIL" },
    2: { tok: TOK(96), latency: 760, successBps: 10000, label: "96.0 tok/s (claimed 95.0) -> PASS" },
  };

  // Poll for newly-funded jobs rather than using contract.on — Hardhat's
  // in-process provider doesn't reliably deliver event subscriptions to
  // scripts, and polling keeps the harness deterministic.
  let oracleRunning = true;
  const settledJobs = new Set();

  const oracleLoop = (async () => {
    while (oracleRunning) {
      try {
        const nextJobId = await market.nextJobId();
        for (let id = 1n; id < nextJobId; id += 1n) {
          if (settledJobs.has(id.toString())) continue;
          const job = await market.getJob(id);
          if (Number(job.status) !== 1) continue; // 1 = Funded, awaiting verification

          const plan = measuredFor[Number(job.listingId)];
          if (!plan) continue;

          settledJobs.add(id.toString());
          // Brief pause so the agent's watcher is attached before we settle.
          await new Promise((r) => setTimeout(r, 1200));
          console.log(`\n  [oracle] job #${id} on listing #${job.listingId}: submitting ${plan.label}`);
          await (await market.connect(oracle).submitVerification(id, plan.tok, plan.latency, plan.successBps)).wait();
        }
      } catch {
        // transient read error — keep looping
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  })();

  // Launch the autonomous agent.
  console.log(`\n${"=".repeat(72)}\nHanding over to the autonomous agent — no further human input.\n${"=".repeat(72)}`);

  const agentDir = path.join(__dirname, "..", "..", "buyer-agent");
  const child = spawn(
    "node",
    ["index.js", "--min-tok-s", "90", "--hours", "1", "--max-retries", "2", "--max-spend", "0.05"],
    {
      cwd: agentDir,
      env: {
        ...process.env,
        RPC_URL: "http://127.0.0.1:8545",
        CONTRACT_ADDRESS: address,
        AGENT_PRIVATE_KEY,
      },
      stdio: "inherit",
    }
  );

  const code = await new Promise((resolve) => child.on("close", resolve));
  oracleRunning = false;
  await oracleLoop;
  console.log(`\nAgent process exited with code ${code}.`);
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
