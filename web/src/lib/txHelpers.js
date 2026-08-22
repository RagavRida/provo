import { writeContractSync } from "viem/actions";

/**
 * Writes to a contract using Monad's eth_sendRawTransactionSync RPC method
 * (via viem's writeContractSync action) — submits the transaction and gets
 * the receipt back in the same round-trip, instead of the usual two-step
 * writeContract + waitForTransactionReceipt. See the monad-scaffold skill:
 * "Use useSendTransactionSync wherever it can be used."
 *
 * Falls back to the standard two-step flow if the connected RPC doesn't
 * support the sync method (e.g. a non-Monad-aware wallet RPC proxy) so the
 * app still works, just without the latency win.
 */
export async function writeSync(walletClient, params) {
  try {
    return await writeContractSync(walletClient, params);
  } catch (err) {
    const message = (err && (err.shortMessage || err.message)) || "";
    const unsupported =
      message.includes("does not exist") ||
      message.includes("not supported") ||
      message.includes("Method not found") ||
      err?.code === -32601;
    if (!unsupported) throw err;
    return null; // signal caller to fall back
  }
}
