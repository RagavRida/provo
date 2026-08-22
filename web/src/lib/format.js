import { formatEther } from "viem";

export function formatMon(wei) {
  if (wei === undefined || wei === null) return "0";
  return Number(formatEther(BigInt(wei))).toFixed(4);
}

export function shortenAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
