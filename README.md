# Provo

Provo is a verified GPU compute marketplace on Monad. It includes:

- `contracts/` for the on-chain marketplace
- `agent/` for benchmarking GPU providers
- `oracle/` for submitting benchmark results on-chain
- `web/` for the frontend
- `buyer-agent/` for the autonomous on-chain buyer

## Judge Links

- Public repository: [github.com/RagavRida/provo](https://github.com/RagavRida/provo)
- Monad Testnet contract: [`0xd599252a6F75b6dD1035d6DeB94985D30C396686`](https://testnet.monadscan.com/address/0xd599252a6F75b6dD1035d6DeB94985D30C396686)
- Published contract source: [Monad Sourcify verification](https://testnet.monadverifier.com/contracts/full_match/10143/0xd599252a6F75b6dD1035d6DeB94985D30C396686/)
- Live app: [web-alpha-coral-61.vercel.app](https://web-alpha-coral-61.vercel.app)

During the pitch, say the repository URL, the contract address, the live app URL, and that Provo is deployed on Monad Testnet.

## What you need

- Node.js 18 or newer
- `npm`
- A Monad testnet wallet and RPC access if you want to deploy or use the live flow

## Project Layout

| Folder | Purpose |
|---|---|
| `contracts/` | Solidity marketplace contract, tests, and deploy scripts |
| `agent/` | Benchmark agent that compares provider performance and cost |
| `oracle/` | Bridge that submits benchmark results to the contract |
| `web/` | React frontend for marketplace, provider, and buyer flows |
| `buyer-agent/` | Autonomous buyer that funds jobs and reroutes on failure |

## Quick Start

If you want the full testnet setup, start with [TESTNET.md](./TESTNET.md).

If you only want to run the pieces locally, use the sections below.

## 1. Contracts

From `contracts/`:

```bash
npm install
npm test
npm run compile
```

Deploy to Monad testnet:

```bash
npm run deploy:testnet
```

Set `ORACLE_ADDRESS` before deploying. After deployment, use the printed contract address in the other apps.

## 2. Benchmark Agent

From `agent/`:

```bash
npm install
npm run mock
```

Use `npm start` for live provider checks.

Environment variables are provider-specific and listed in `providers.json`. Each provider needs its own API key in the environment.

The agent prints:

- measured throughput and latency
- success rate
- effective cost per million tokens
- the oracle payload to submit on-chain

## 3. Oracle Bridge

From `oracle/`:

```bash
npm install
node index.js --payload ./payload.json
```

You can also pass the values directly:

```bash
node index.js --jobId 3 --tokPerSec 90650000 --latencyMs 793 --successBps 6667
```

Required environment variables:

- `ORACLE_PRIVATE_KEY`
- `CONTRACT_ADDRESS`
- optional `MONAD_TESTNET_RPC`

## 4. Web App

From `web/`:

```bash
npm install
npm run dev
```

Set `VITE_CONTRACT_ADDRESS` to the deployed marketplace address.

The checked-in default is the public Monad Testnet demo contract, so the app
also opens against a live marketplace without a local `.env`. The current
public deployment is hosted on Vercel. `render.yaml` also includes a
`provo-web` static service if you prefer deploying a Render Blueprint.

## 5. Buyer Agent

From `buyer-agent/`:

```bash
npm install
npm test
```

To run it against a deployed contract:

```bash
node index.js --min-tok-s 90 --hours 1 --max-retries 2 --max-spend 0.05
```

Required environment variables:

- `CONTRACT_ADDRESS`
- `AGENT_PRIVATE_KEY`

## Typical Workflow

1. Deploy the contract from `contracts/`.
2. Copy the deployed address into `oracle/`, `web/`, and any agent config that needs it.
3. Run the benchmark agent in `agent/` to measure providers.
4. Submit the selected benchmark payload through `oracle/`.
5. Open the frontend in `web/` to view and use the marketplace.
6. Optionally run `buyer-agent/` to automate buyer selection and settlement handling.

## Testing

- `contracts/`: `npm test`
- `agent/`: `npm run mock`
- `buyer-agent/`: `npm test`

## Additional Notes

- `TESTNET.md` has the full Monad testnet runbook.
- `buyer-agent/README.md` has the autonomous buyer setup in more detail.
