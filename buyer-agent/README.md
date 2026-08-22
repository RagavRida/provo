# Provo Autonomous Buyer Agent

An on-chain agent that shops for GPU compute by itself. You fund its wallet once and give it a workload spec; it picks a provider, pays into escrow, watches the verified result land on-chain, and — if the provider underdelivers and gets slashed — re-routes to the next best provider on its own, with no human approval in the loop.

> Talks to the deployed `ProvoMarketplace` contract (referred to as the "ComputeSLA contract" in the product spec — same interface).

## The loop

```
read listings → score by reputation-adjusted cost → fund best → watch settlement
                        ↑                                              │
                        └────────── auto-reroute on FAIL ──────────────┘
                                  (bounded by maxRetries + spend cap)
```

1. **Read** every listing and its `reputationScoreBps` from chain.
2. **Score** each by effective cost — `pricePerHour / claimedTokPerSec`, divided by the provider's reputation so an unreliable provider is scored as if it cost proportionally more. Providers with no settled jobs get a **neutral 75% prior** rather than being excluded, so new entrants can compete.
3. **Select & fund** the best-scoring listing via `fundJob(listingId)`.
4. **Watch** for that job's `JobSettled` event.
5. **Pass** → report success and stop.
6. **Fail** → the contract has already refunded the escrow and slashed the provider; the agent immediately re-scores the remaining providers and funds the next best one, using the recovered funds. No human approval.
7. **Track** cumulative spend and refuse any job that would breach the cap.

## Safety guardrails

- **`maxTotalSpendWei` is re-checked immediately before every single funding transaction** — not just at selection time — so it holds even if chain state shifts mid-run. There is no override flag and no way to raise it during a session.
- Listings whose job cost exceeds the *remaining* allowance are filtered out before they're ever ranked.
- A listing is **never retried twice in one session**, including one that reverted on funding.
- Wallet balance is checked independently of the cap.
- Terminal states (`no_eligible_listings`, `spend_cap_reached`, `retries_exhausted`, `settlement_timeout`) produce a clean final report and a non-zero exit code — the agent never hangs or throws unhandled.

Refunded escrow is credited back against the cap (it was returned), while the slash is tracked as recovery. The final report shows net position.

## Usage

```bash
npm install
cp .env.example .env    # set CONTRACT_ADDRESS and AGENT_PRIVATE_KEY

node index.js --min-tok-s 90 --hours 1 --max-retries 2 --max-spend 0.05
```

| Flag | Meaning | Default |
|---|---|---|
| `--min-tok-s` | Minimum acceptable throughput (tok/s) | 90 |
| `--hours` | Hours of compute to fund per job | 1 |
| `--max-retries` | Automatic re-routes after a failure | 2 |
| `--max-spend` | **Hard** total spend cap, in MON | 0.05 |

Exit code is `0` only on a passing job.

## Tests

```bash
npm test        # 12 unit tests over the scoring/eligibility logic
```

End-to-end, against a local chain (from `../contracts`, with `npx hardhat node` running):

```bash
npx hardhat run scripts/localDemo.js     --network localhost   # full fail → reroute → pass flow
npx hardhat run scripts/guardrailTest.js --network localhost   # spend-cap enforcement
```

## Demo narrative

`localDemo.js` seeds three listings and hands control to the agent:

| # | Claim | Price | Role in the demo |
|---|---|---|---|
| 1 | 100 tok/s | 0.010 MON/hr | Headline-best score — **underdelivers at 60 tok/s** |
| 2 | 95 tok/s | 0.014 MON/hr | Honest — delivers 96 tok/s |
| 3 | 60 tok/s | 0.009 MON/hr | Filtered out, below the workload minimum |

The agent picks #1 (genuinely the best-looking deal), gets a bad result, is auto-refunded plus compensated from the provider's slashed stake, excludes #1, and immediately funds #2 — which passes.

The punchline from the verified run: **the 0.004 MON slashed from the bad provider exactly covered the 0.014 MON retry**, leaving the buyer net-neutral on the wasted attempt. The buyer didn't eat the cost of the lie — the provider did.
