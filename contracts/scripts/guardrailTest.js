/**
 * Verifies the agent's hard spending cap actually holds, and that it fails
 * gracefully (clean report, non-zero exit, no hang, no unhandled throw)
 * rather than overspending or crashing.
 *
 * Case A: cap below the cheapest job          -> funds nothing at all
 * Case B: cap covers attempt 1 but not retry  -> funds once, then stops cleanly
 *
 * Run against a local node:
 *   npx hardhat run scripts/guardrailTest.js --network localhost
 */

const hre = require("hardhat");
const { spawn } = require("child_process");
const path = require("path");

const TOK = (n) => BigInt(Math.round(n * 1e6));
const ETH = (n) => hre.ethers.parseEther(String(n));
const AGENT_PRIVATE_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

async function deployScenario() {
  const [deployer, oracle, providerA, providerB] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("ProvoMarketplace", deployer);
  const market = await Factory.deploy(oracle.address);
  await market.waitForDeployment();

  await (await market.connect(providerA).createListing("H100", TOK(100), ETH("0.010"), { value: ETH("1.0") })).wait();
  await (await market.connect(providerB).createListing("H100", TOK(95), ETH("0.014"), { value: ETH("1.0") })).wait();

  const agentWallet = new hre.ethers.Wallet(AGENT_PRIVATE_KEY, hre.ethers.provider);
  await (await deployer.sendTransaction({ to: agentWallet.address, value: ETH("1.0") })).wait();

  return { market, oracle, address: await market.getAddress(), agentWallet };
}

function runAgent(address, maxSpend) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(
      "node",
      ["index.js", "--min-tok-s", "90", "--hours", "1", "--max-retries", "2", "--max-spend", maxSpend],
      {
        cwd: path.join(__dirname, "..", "..", "buyer-agent"),
        env: { ...process.env, RPC_URL: "http://127.0.0.1:8545", CONTRACT_ADDRESS: address, AGENT_PRIVATE_KEY },
      }
    );
    child.stdout.on("data", (d) => chunks.push(d.toString()));
    child.stderr.on("data", (d) => chunks.push(d.toString()));
    child.on("close", (code) => resolve({ code, output: chunks.join("") }));
  });
}

async function main() {
  let failures = 0;
  const check = (name, cond, detail = "") => {
    console.log(`  ${cond ? "✔" : "✘"} ${name}${cond ? "" : `\n      ${detail}`}`);
    if (!cond) failures += 1;
  };

  // ---- Case A: cap below the cheapest available job ----
  console.log("\nCase A — spend cap (0.005 MON) below cheapest job (0.010 MON)");
  {
    const { address, agentWallet } = await deployScenario();
    const before = await hre.ethers.provider.getBalance(agentWallet.address);
    const { code, output } = await runAgent(address, "0.005");
    const after = await hre.ethers.provider.getBalance(agentWallet.address);

    check("funds nothing (no fundJob sent)", !output.includes("[FUND]"));
    check("reports no_eligible_listings", output.includes("NO_ELIGIBLE_LISTINGS"));
    check("exits non-zero", code !== 0, `exit was ${code}`);
    check("no unhandled crash", !output.includes("UnhandledPromiseRejection") && !output.includes("[FATAL]"));
    check("wallet balance unchanged (no spend)", before === after, `${before} -> ${after}`);
  }

  // ---- Case B: cap covers the first job but not the retry ----
  console.log("\nCase B — cap (0.012 MON) covers attempt 1 (0.010) but not the retry (0.014)");
  {
    const { market, oracle, address } = await deployScenario();

    // Oracle fails the first job so the agent tries to re-route.
    let running = true;
    const seen = new Set();
    const loop = (async () => {
      while (running) {
        try {
          const nextJobId = await market.nextJobId();
          for (let id = 1n; id < nextJobId; id += 1n) {
            if (seen.has(id.toString())) continue;
            const job = await market.getJob(id);
            if (Number(job.status) !== 1) continue;
            seen.add(id.toString());
            await new Promise((r) => setTimeout(r, 1000));
            await (await market.connect(oracle).submitVerification(id, TOK(60), 1200, 9200)).wait();
          }
        } catch {
          /* keep polling */
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    })();

    const { code, output } = await runAgent(address, "0.012");
    running = false;
    await loop;

    const fundCount = (output.match(/\[FUND\]   Sending/g) || []).length;
    check("funds exactly once", fundCount === 1, `saw ${fundCount} funding attempts`);
    check("refuses the over-cap retry", output.includes("NO_ELIGIBLE_LISTINGS"));
    check("names the budget constraint in the report", output.includes("remaining budget"));
    check("exits non-zero", code !== 0, `exit was ${code}`);
    check("no unhandled crash", !output.includes("UnhandledPromiseRejection") && !output.includes("[FATAL]"));
  }

  console.log(failures === 0 ? "\nAll guardrail checks passed.\n" : `\n${failures} guardrail check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
