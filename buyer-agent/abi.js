// ABI slice the buyer agent needs from the deployed marketplace contract (v2).
export const MARKETPLACE_ABI = [
  "function nextListingId() view returns (uint256)",
  "function nextJobId() view returns (uint256)",
  "function getListing(uint256) view returns (tuple(address provider, string gpuModel, uint256 vramGb, string region, uint256 claimedTokPerSec, uint256 pricePerHour, uint256 stake, bool active, uint256 passedJobs, uint256 totalJobs))",
  "function getJob(uint256) view returns (tuple(uint256 listingId, address buyer, uint256 escrow, uint8 status, uint256 measuredTokPerSec, uint256 measuredLatencyMs, uint256 measuredSuccessBps, bool passed, uint256 slashedAmount))",
  "function reputationScoreBps(uint256) view returns (uint256)",
  "function fundJob(uint256 listingId) payable returns (uint256)",
  "event JobFunded(uint256 indexed jobId, uint256 indexed listingId, address indexed buyer, uint256 escrow)",
  "event JobSettled(uint256 indexed jobId, uint256 indexed listingId, bool passed, uint256 paidToProvider, uint256 refundedToBuyer, uint256 slashedAmount)",
];
