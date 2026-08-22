import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { MONAD_TESTNET } from "./contract";

/**
 * Minimal MetaMask wallet-connect hook. Monad is EVM-compatible so MetaMask
 * works unmodified — this just wraps window.ethereum with viem clients and
 * prompts a network switch/add if the user isn't on Monad testnet yet.
 */
export function useWallet() {
  const [address, setAddress] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const publicClient = useMemo(
    () => createPublicClient({ chain: MONAD_TESTNET, transport: http() }),
    []
  );

  const walletClient = useMemo(() => {
    if (typeof window === "undefined" || !window.ethereum) return null;
    return createWalletClient({ chain: MONAD_TESTNET, transport: custom(window.ethereum) });
  }, []);

  const ensureMonadNetwork = useCallback(async () => {
    if (!window.ethereum) return;
    const chainIdHex = `0x${MONAD_TESTNET.id.toString(16)}`;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    } catch (switchError) {
      if (switchError.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: chainIdHex,
              chainName: MONAD_TESTNET.name,
              nativeCurrency: MONAD_TESTNET.nativeCurrency,
              rpcUrls: MONAD_TESTNET.rpcUrls.default.http,
              blockExplorerUrls: [MONAD_TESTNET.blockExplorers.default.url],
            },
          ],
        });
      } else {
        throw switchError;
      }
    }
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("No wallet found. Install MetaMask to continue.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
      await ensureMonadNetwork();
      setAddress(account);
    } catch (err) {
      setError(err.shortMessage || err.message || "Failed to connect wallet.");
    } finally {
      setConnecting(false);
    }
  }, [ensureMonadNetwork]);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    const handleAccountsChanged = (accounts) => setAddress(accounts[0] || null);
    window.ethereum.on?.("accountsChanged", handleAccountsChanged);
    return () => window.ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
  }, []);

  return { address, connecting, error, connect, publicClient, walletClient };
}
