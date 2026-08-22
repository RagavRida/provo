// Minimal ABI slice needed by the oracle bridge — only the function and
// events it actually calls/reads. Regenerate from the full Hardhat artifact
// (contracts/artifacts/contracts/ProvoMarketplace.sol/ProvoMarketplace.json)
// after any contract change, or just extend this array to match.
export const PROVO_MARKETPLACE_ABI = [
  {
    type: "function",
    name: "nextJobId",
    stateMutability: "view",
    inputs: [],
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
    name: "submitVerification",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "measuredTokPerSec", type: "uint256" },
      { name: "measuredLatencyMs", type: "uint256" },
      { name: "measuredSuccessBps", type: "uint256" },
    ],
    outputs: [],
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
