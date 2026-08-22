# Deploying Provo to Monad testnet + running the buyer agent end-to-end

Network parameters verified live at time of writing — **re-check against
<https://docs.monad.xyz> before a demo, testnet endpoints rotate**:

| Parameter | Value |
|---|---|
| RPC | `https://testnet-rpc.monad.xyz` |
| Chain ID | `10143` (`0x279f`) |
| Base fee observed | ~102 gwei |
| Explorer | `https://testnet.monadscan.com` |
| `eth_sendRawTransactionSync` | supported |

> **Monad charges gas on the LIMIT, not on usage.** Every script here pins an
> explicit tight `gasLimit` for that reason. Don't remove them.

---

## 0. Wallets you need

Three separate keys. Keep them distinct — an oracle that is also the provider
is a provider grading its own homework, which undercuts the whole demo.

| Role | Purpose | Fund with |
|---|---|---|
| **Deployer / provider** | deploys the contract, creates + stakes the 3 listings | **1.0 MON** |
| **Oracle** | submits verification results | **0.2 MON** |
| **Agent** | the autonomous buyer's own wallet | **0.2 MON** |

Cost basis at 102 gwei (charged on limit):

- deploy @ 3M limit ≈ 0.306 MON
- `createListing` @ 260k ≈ 0.0265 MON each, plus 0.05 MON stake × 3
- `submitVerification` @ 320k ≈ 0.0326 MON each
- `fundJob` @ 220k ≈ 0.0224 MON each, plus escrow (0.010 + 0.014 MON)

Generate keys with any wallet, or:

```bash
node -e "const {Wallet}=require('ethers');for(const r of ['DEPLOYER','ORACLE','AGENT']){const w=Wallet.createRandom();console.log(r, w.address, w.privateKey)}"
```

Fund each from the Monad testnet faucet (see the `monad-tooling-and-infra`
skill / official docs for the current faucet). The `monad-wallet` skill also
documents a programmatic faucet:

```bash
curl -s -X POST https://agents.devnads.com/v1/faucet \
  -H "Content-Type: application/json" \
  -d '{"chainId": 10143, "address": "0xYOUR_ADDRESS"}'
```

Verify balances before continuing:

```bash
cd contracts
node -e "
const {JsonRpcProvider,formatEther}=require('ethers');
const p=new JsonRpcProvider('https://testnet-rpc.monad.xyz');
(async()=>{for(const a of ['0xDEPLOYER','0xORACLE','0xAGENT'])
  console.log(a, formatEther(await p.getBalance(a)), 'MON')})()
"
```

---

## 1. Deploy the contract

```bash
cd contracts
npm install
npm test                 # 9 tests must pass before you spend real gas
```

**Option A — plain Hardhat deploy** (simplest):

```bash
cp .env.example .env
# set DEPLOYER_PRIVATE_KEY and ORACLE_ADDRESS (the oracle wallet's ADDRESS)
npm run deploy:testnet
```

**Option B — Alchemy Agent Wallet + CREATE2** (no raw key on disk; see the
`monad-wallet` skill):

```bash
npx hardhat compile
node scripts/create2Deploy.js --oracle 0xORACLE_ADDRESS --network testnet
# then run the printed `alchemy evm contract call ... deployCreate2(...)` yourself
```

Save the deployed address:

```bash
export CONTRACT=0xDEPLOYED_ADDRESS
```

Confirm it has code:

```bash
curl -s -X POST https://testnet-rpc.monad.xyz -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$CONTRACT\",\"latest\"],\"id\":1}" \
  | head -c 120
```

Then verify the source on the explorers (one call, all three) — see the
verification API section in the root `README.md`.

---

## 2. Seed the three demo listings

From the **deployer/provider** wallet (`DEPLOYER_PRIVATE_KEY` in
`contracts/.env`):

```bash
cd contracts
CONTRACT_ADDRESS=$CONTRACT npx hardhat run scripts/seedTestnet.js --network monadTestnet
```

This creates exactly the set that makes the agent's failure-and-reroute legible:

| # | Claim | Price | Stake | Role |
|---|---|---|---|---|
| 1 | 100 tok/s | 0.010 MON/hr | 0.05 | **headline-best score — will underdeliver** |
| 2 | 95 tok/s | 0.014 MON/hr | 0.05 | honest — delivers |
| 3 | 60 tok/s | 0.009 MON/hr | 0.05 | below the workload minimum, filtered out |

The script refuses to run if the wallet can't cover stakes + gas, and prints a
tx hash per listing.

---

## 3. Start the oracle watcher

**Separate terminal.** This is what makes the demo unattended: it polls for
funded jobs and settles them per policy.

```bash
cd oracle
npm install
RPC_URL=https://testnet-rpc.monad.xyz \
CONTRACT_ADDRESS=$CONTRACT \
ORACLE_PRIVATE_KEY=0xORACLE_KEY \
node watch.js
```

Default policy: listing #1 → 60 tok/s (FAIL vs its 100 claim), listing #2 →
96 tok/s (PASS vs its 95 claim). Override with `--policy ./file.json`.

In production these numbers come from `agent/` actually benchmarking the
provider endpoints; they're fixed here so the on-stage outcome is deterministic.

Leave it running.

---

## 4. Run the autonomous buyer agent

**Third terminal.** This is the demo.

```bash
cd buyer-agent
npm install
npm test        # 12 scoring unit tests

RPC_URL=https://testnet-rpc.monad.xyz \
CONTRACT_ADDRESS=$CONTRACT \
AGENT_PRIVATE_KEY=0xAGENT_KEY \
node index.js --min-tok-s 90 --hours 1 --max-retries 2 --max-spend 0.05
```

Expected sequence:

1. Reads all 3 listings, filters #3 (below 90 tok/s minimum)
2. Scores #1 best (cheapest per claimed tok/s), funds 0.010 MON
3. Oracle settles it FAIL at 60 tok/s → escrow refunded + ~0.004 MON slashed
4. Agent excludes #1, re-scores, funds #2 at 0.014 MON — **no human input**
5. Oracle settles PASS at 96 tok/s → provider paid
6. Final report, exit code 0

Watch every tx land on `https://testnet.monadscan.com`.

---

## 5. Optional — the frontend

```bash
cd web
cp .env.example .env      # VITE_CONTRACT_ADDRESS=$CONTRACT
npm install && npm run dev
```

MetaMask prompts to add/switch to Monad testnet automatically.

---

## Demo-day checklist

- [ ] All three wallets funded, balances confirmed on-chain
- [ ] Contract deployed **and source-verified** on the explorer
- [ ] `seedTestnet.js` run; 3 listings visible in the frontend
- [ ] Oracle watcher running in its own terminal, showing "Watching for funded jobs…"
- [ ] `buyer-agent` dependencies installed, `npm test` green
- [ ] Explorer tab open on the contract address
- [ ] Re-confirm the RPC still responds (`eth_chainId` → `0x279f`)

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Provo: not oracle` on settle | `ORACLE_PRIVATE_KEY` doesn't match the address passed to the constructor. Rotate with `setOracle(newOracle)` from the owner wallet. |
| Agent reports `no_eligible_listings` immediately | Listings not seeded, all below `--min-tok-s`, or job cost exceeds `--max-spend`. |
| Agent stops at `spend_cap_reached` | Working as designed — the cap is hard. Raise `--max-spend` deliberately. |
| `settlement_timeout` | Oracle watcher isn't running, or its policy has no entry for that listing ID. |
| Agent hangs at `[WATCH]` | Shouldn't happen: the watcher races the event subscription against a 2s poll. If it does, the RPC is dropping both — switch endpoint. |
| `insufficient funds for gas` | Remember Monad bills the full gas limit; top up. |

## Caveat

This runbook's flow is verified end-to-end on a **local Hardhat chain**
(`scripts/localDemo.js` — fail → auto-reroute → pass, plus
`scripts/guardrailTest.js` for spend-cap enforcement). The network parameters
above were confirmed against live testnet RPC, but the full three-wallet
sequence has **not** been executed on testnet — that needs funded keys. Budget
time for a dry run before presenting.
