# Provo Submission Kit

## Links to say out loud

- Repository: https://github.com/RagavRida/provo
- Live app: https://web-alpha-coral-61.vercel.app
- Monad Testnet contract: https://testnet.monadscan.com/address/0xd599252a6F75b6dD1035d6DeB94985D30C396686
- Deployment: Monad Testnet, chain ID 10143

## 45-second pitch

"Provo is a verified GPU compute marketplace on Monad. Today, a provider can
claim an H100 is fast, charge for it, and leave the buyer to discover later
whether that claim was real. Provo changes that: providers stake MON behind a
throughput claim, a benchmark measures delivered performance, and an oracle
settles the payment on-chain. If the GPU performs, the provider is paid. If it
under-delivers, the buyer gets their escrow back and the provider is slashed.

Our autonomous buyer agent makes this practical: it scores providers by
effective cost, funds the best one within a fixed spend cap, and reroutes
without human approval when a provider fails. The repo is github.com/RagavRida/provo,
the live app is web-alpha-coral-61.vercel.app, and the contract is deployed on
Monad Testnet at 0xd599252a6F75b6dD1035d6DeB94985D30C396686. A GPU costs what
it delivers, not what it claims."

## 30-second demo video

| Time | Screen | Say |
|---|---|---|
| 0-4s | Marketplace listing cards | "GPU listings are claims backed by MON stake." |
| 4-9s | `npm run mock` comparison table | "Sticker price is misleading: Provo ranks effective cost from measured performance." |
| 9-16s | Autonomous buyer terminal, first fund transaction | "The agent funds the best listing within a hard 0.05 MON cap." |
| 16-22s | Failure settlement and slash in terminal/explorer | "It underdelivers, so the buyer is refunded and the provider is slashed." |
| 22-28s | Retry and pass settlement | "The agent reroutes automatically and pays only the provider that delivers." |
| 28-30s | Live app URL + contract explorer | "Provo: a GPU costs what it delivers, not what it claims." |

Record the local deterministic flow with:

```bash
cd contracts
npx hardhat node
npx hardhat run scripts/localDemo.js --network localhost
```

For the on-chain proof, keep the Monadscan contract page open and show a
successful `JobFunded` transaction during the live pitch.

## Social post

Built Provo for Monad: a verified GPU compute marketplace where providers stake MON behind performance claims.

Buyers pay for delivered throughput, not a GPU label. Our agent measures effective cost, funds the best provider within a hard cap, and automatically reroutes if performance fails. Settlement, refunds, and slashing happen on-chain.

Live: https://web-alpha-coral-61.vercel.app
Contract: https://testnet.monadscan.com/address/0xd599252a6F75b6dD1035d6DeB94985D30C396686

@monad @monad_dev @geeky_kartikey

## Creative-ad hook

Open on a price tag reading "$1.50/hr H100." Cut to a loading bar and reveal:
"But what did it actually deliver?" Then show Provo measuring the workload,
slashing the underperformer, and rerouting to a provider that passes. Close on:
"Stop renting claims. Rent results."
