// Deployed ProvoMarketplace contract address + ABI + chain config.
// Fill CONTRACT_ADDRESS after running `npm run deploy:testnet` in /contracts.
export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";

// Confirm chainId/RPC against https://docs.monad.xyz before demoing — testnet
// endpoints rotate.
export const MONAD_TESTNET = {
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [import.meta.env.VITE_MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "Monad Testnet Explorer", url: "https://testnet.monadscan.com" },
  },
};

// Minimal ABI slice the frontend actually calls/reads/listens to.
export const PROVO_MARKETPLACE_ABI = [
  {
    type: "function",
    name: "createListing",
    stateMutability: "payable",
    inputs: [
      { name: "gpuModel", type: "string" },
      { name: "vramGb", type: "uint256" },
      { name: "region", type: "string" },
      { name: "claimedTokPerSec", type: "uint256" },
      { name: "pricePerHour", type: "uint256" },
    ],
    outputs: [{ name: "listingId", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdrawListing",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "fundJob",
    stateMutability: "payable",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function",
    name: "reputationScoreBps",
    stateMutability: "view",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getListing",
    stateMutability: "view",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "provider", type: "address" },
          { name: "gpuModel", type: "string" },
          { name: "vramGb", type: "uint256" },
          { name: "region", type: "string" },
          { name: "claimedTokPerSec", type: "uint256" },
          { name: "pricePerHour", type: "uint256" },
          { name: "stake", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "passedJobs", type: "uint256" },
          { name: "totalJobs", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "listingId", type: "uint256" },
          { name: "buyer", type: "address" },
          { name: "escrow", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "measuredTokPerSec", type: "uint256" },
          { name: "measuredLatencyMs", type: "uint256" },
          { name: "measuredSuccessBps", type: "uint256" },
          { name: "passed", type: "bool" },
          { name: "slashedAmount", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "nextListingId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "ListingCreated",
    inputs: [
      { name: "listingId", type: "uint256", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "gpuModel", type: "string", indexed: false },
      { name: "vramGb", type: "uint256", indexed: false },
      { name: "region", type: "string", indexed: false },
      { name: "claimedTokPerSec", type: "uint256", indexed: false },
      { name: "pricePerHour", type: "uint256", indexed: false },
      { name: "stake", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobFunded",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "listingId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "escrow", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobVerified",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "measuredTokPerSec", type: "uint256", indexed: false },
      { name: "measuredLatencyMs", type: "uint256", indexed: false },
      { name: "measuredSuccessBps", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobSettled",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "listingId", type: "uint256", indexed: true },
      { name: "passed", type: "bool", indexed: false },
      { name: "paidToProvider", type: "uint256", indexed: false },
      { name: "refundedToBuyer", type: "uint256", indexed: false },
      { name: "slashedAmount", type: "uint256", indexed: false },
    ],
  },
];

// tok/s values are scaled by 1e6 on-chain to avoid fixed-point math.
export const TOK_PER_SEC_SCALE = 1_000_000n;

export function formatTokPerSec(scaled) {
  return (Number(scaled) / 1_000_000).toFixed(1);
}

export function bpsToPercent(bps) {
  return (Number(bps) / 100).toFixed(1);
}
