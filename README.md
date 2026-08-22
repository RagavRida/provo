# Provo

**A GPU costs what it delivers, not what it claims.**

A verified GPU compute marketplace on Monad. Providers stake MON behind a performance claim; a benchmark agent measures real delivered throughput; an oracle submits the result on-chain; a smart contract auto-settles — pay the provider on a pass, refund the buyer plus a proportional slash of the provider's stake on a fail.

Mechanism: **claim → stake → escrow → execute → verify → settle.**

## Structure

| Folder | Phase | What it is |
|---|---|---|
| `contracts/` | 1 | `ProvoMarketplace.sol` (Solidity 0.8.24, Hardhat), 9 passing tests |
| `agent/` | 2 | Node.js benchmark agent — measures tok/s + reliability across providers, outputs an effective-cost comparison table and the oracle payload |
| `oracle/` | 3 | Minimal single-signer bridge — calls `submitVerification` on-chain with the agent's measured numbers |
| `web/` | 4 | React + Vite + Tailwind + viem frontend — marketplace, buyer flow, provider flow |

## Quickstart

### 1. Deploy the contract (testnet)

Two ways to deploy — pick one:

**Option A — Alchemy Agent Wallet + CREATE2 via CreateX (recommended, no raw private key)**

Matches the `monad-wallet` skill: your key stays in Alchemy's enclave, an agent only ever holds a revocable session token.

```bash
cd contracts
npm install
npm test                                    # 9 tests should pass
npx hardhat compile
node scripts/create2Deploy.js --oracle 0xYourOracleAddress --network testnet
```

This predicts the deployment address and prints the exact `alchemy evm contract call ... deployCreate2(...)` command. You (not the agent) then run, once:

```bash
npm install -g @alchemy/cli@latest
alchemy auth                     # or: alchemy auth login --device-code (headless)
# create an EVM Agent Wallet session at https://dashboard.alchemy.com/products/agent-wallet/evm-wallet
alchemy wallet connect --mode session
alchemy wallet use session
alchemy config set network monad-testnet
```

then paste the printed `alchemy evm contract call` command to actually deploy.

**Option B — plain Hardhat deploy with a raw private key**

```bash
cd contracts
cp .env.example .env   # fill in DEPLOYER_PRIVATE_KEY and ORACLE_ADDRESS
npm install
npm test
npm run deploy:testnet          # confirm RPC/chainId against docs.monad.xyz first
```

Only use a throwaway testnet key here, never your main wallet's key.

Either way, verify the deployed contract via the verification API (see the `monad-scaffold` skill) so it shows up cleanly on the explorer for the demo.

### 2. Run the benchmark agent

```bash
cd agent
npm run mock     # simulated, clearly labeled — no live provider accounts needed
# or, with real provider API keys set as env vars matching providers.json:
npm start
```

Prints a comparison table sorted by *effective* cost per million tokens, plus the exact JSON payload for `submitVerification`.

### 3. Submit a verification via the oracle bridge

```bash
cd oracle
cp .env.example .env   # fill in ORACLE_PRIVATE_KEY (must match the contract's oracle address) and CONTRACT_ADDRESS
npm install
node index.js --jobId <id> --tokPerSec <scaled> --latencyMs <ms> --successBps <bps>
```

### 4. Run the frontend

```bash
cd web
cp .env.example .env   # fill in VITE_CONTRACT_ADDRESS after deploying
npm install
npm run dev
```

MetaMask works unmodified since Monad is EVM-compatible — the app will prompt to add/switch to Monad testnet on connect.

## Demo script (3 min)

1. "Is an H100 really an H100?" — show 3 listings at different prices for the same GPU model.
2. Cite the ~34.5% real-world performance variation among "identical" H100s.
3. Run `npm run mock` in `agent/` live — show the advertised-cheapest listing diverge from the actually-cheapest-by-effective-cost listing.
4. `fundJob` → `submitVerification` live on Monad testnet — show the explorer transaction and the automatic payout or slash.
5. Close: "A GPU costs what it delivers, not what it claims."

## Hackathon scope / cut for time

- Single trusted oracle address (owner-settable), no dispute window, no decentralized oracle network — see `ProvoMarketplace.sol` comments for the v2 roadmap.
- One workload type benchmarked (not multi-workload).
- One logo, one palette, one type pairing — no lockups, motion, or templates.

## Autonomous buyer agent

`buyer-agent/` contains a fully autonomous on-chain buyer: fund its wallet once, hand it a workload spec, and it selects a provider, pays, watches settlement, and auto-reroutes to the next best provider if the first one underdelivers — all within a hard, non-overridable spending cap. See `buyer-agent/README.md`.

```bash
cd buyer-agent && npm install && npm test     # 12 scoring/eligibility unit tests

# end-to-end on a local chain (needs `npx hardhat node` running in contracts/)
cd contracts
npx hardhat run scripts/localDemo.js     --network localhost   # fail → auto-reroute → pass
npx hardhat run scripts/guardrailTest.js --network localhost   # spend-cap enforcement
```

## Deploying to Monad testnet

See **[TESTNET.md](./TESTNET.md)** for the full runbook: wallet setup and funding
amounts, deployment (Hardhat or Alchemy Agent Wallet + CREATE2), seeding the demo
listings, running the auto-settling oracle watcher, and driving the autonomous
buyer agent end-to-end — plus a demo-day checklist and troubleshooting table.
