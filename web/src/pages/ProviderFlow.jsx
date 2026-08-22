import { useEffect, useState } from "react";
import { parseEther } from "viem";
import { CONTRACT_ADDRESS, PROVO_MARKETPLACE_ABI, formatTokPerSec } from "../lib/contract";
import { formatMon } from "../lib/format";
import { ReputationBadge } from "../components/StatusBadge";
import { writeSync } from "../lib/txHelpers";

export function ProviderFlow({ address, publicClient, walletClient, onConnect }) {
  const [gpuModel, setGpuModel] = useState("H100");
  const [vramGb, setVramGb] = useState("80");
  const [region, setRegion] = useState("us-east");
  const [claimedTokPerSec, setClaimedTokPerSec] = useState("95");
  const [pricePerHour, setPricePerHour] = useState("0.01");
  const [stake, setStake] = useState("1.0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [myListings, setMyListings] = useState([]);

  async function loadMyListings() {
    if (!address) return;
    try {
      const nextId = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: PROVO_MARKETPLACE_ABI,
        functionName: "nextListingId",
      });
      const ids = Array.from({ length: Number(nextId) - 1 }, (_, i) => BigInt(i + 1));
      const all = await Promise.all(
        ids.map(async (id) => {
          const [listing, reputationBps] = await Promise.all([
            publicClient.readContract({
              address: CONTRACT_ADDRESS,
              abi: PROVO_MARKETPLACE_ABI,
              functionName: "getListing",
              args: [id],
            }),
            publicClient.readContract({
              address: CONTRACT_ADDRESS,
              abi: PROVO_MARKETPLACE_ABI,
              functionName: "reputationScoreBps",
              args: [id],
            }),
          ]);
          return { id, ...listing, reputationBps };
        })
      );
      setMyListings(all.filter((l) => l.provider.toLowerCase() === address.toLowerCase()));
    } catch (err) {
      setError(err.shortMessage || err.message);
    }
  }

  useEffect(() => {
    loadMyListings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  async function handleCreateListing(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (!address) {
        await onConnect();
        return;
      }
      const claimedScaled = BigInt(Math.round(Number(claimedTokPerSec) * 1_000_000));
      const writeParams = {
        address: CONTRACT_ADDRESS,
        abi: PROVO_MARKETPLACE_ABI,
        functionName: "createListing",
        args: [gpuModel, BigInt(vramGb), region, claimedScaled, parseEther(pricePerHour)],
        value: parseEther(stake),
        account: address,
      };

      // Sync send (eth_sendRawTransactionSync) when the RPC supports it,
      // falling back to the standard two-step flow otherwise.
      const receipt = await writeSync(walletClient, writeParams);
      if (receipt) {
        setTxHash(receipt.transactionHash);
      } else {
        const { request } = await publicClient.simulateContract(writeParams);
        const hash = await walletClient.writeContract(request);
        setTxHash(hash);
        await publicClient.waitForTransactionReceipt({ hash });
      }

      await loadMyListings();
    } catch (err) {
      setError(err.shortMessage || err.message || "Failed to create listing.");
    } finally {
      setBusy(false);
    }
  }

  async function handleWithdraw(listingId) {
    setError(null);
    setBusy(true);
    try {
      const writeParams = {
        address: CONTRACT_ADDRESS,
        abi: PROVO_MARKETPLACE_ABI,
        functionName: "withdrawListing",
        args: [listingId],
        account: address,
      };

      const receipt = await writeSync(walletClient, writeParams);
      if (!receipt) {
        const { request } = await publicClient.simulateContract(writeParams);
        const hash = await walletClient.writeContract(request);
        await publicClient.waitForTransactionReceipt({ hash });
      }

      await loadMyListings();
    } catch (err) {
      setError(err.shortMessage || err.message || "Withdraw failed (jobs may still be pending).");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Provide Compute</h1>
      <p className="mt-2 text-sm text-provo-muted">
        Stake MON behind a performance claim. If a benchmark falls short, buyers get refunded plus a slash of your
        stake — so only stake what you're confident your hardware can deliver.
      </p>

      {!address && (
        <button
          type="button"
          onClick={onConnect}
          className="mt-6 rounded-lg bg-provo-pass px-4 py-2.5 text-sm font-semibold text-provo-bg hover:opacity-90"
        >
          Connect Wallet
        </button>
      )}

      {address && (
        <form onSubmit={handleCreateListing} className="mt-6 space-y-4 rounded-xl border border-provo-border bg-provo-surface p-6">
          <div>
            <label className="block text-sm font-medium text-provo-muted" htmlFor="gpuModel">
              GPU model
            </label>
            <input
              id="gpuModel"
              value={gpuModel}
              onChange={(e) => setGpuModel(e.target.value)}
              className="mt-1 w-full rounded-lg border border-provo-border bg-provo-bg px-3 py-2 text-sm outline-none focus:border-provo-pass"
              placeholder="H100"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-provo-muted" htmlFor="vramGb">
                VRAM (GB)
              </label>
              <input
                id="vramGb"
                type="number"
                step="1"
                min="1"
                value={vramGb}
                onChange={(e) => setVramGb(e.target.value)}
                className="mt-1 w-full rounded-lg border border-provo-border bg-provo-bg px-3 py-2 text-sm outline-none focus:border-provo-pass"
                placeholder="80"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-provo-muted" htmlFor="region">
                Region
              </label>
              <select
                id="region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="mt-1 w-full rounded-lg border border-provo-border bg-provo-bg px-3 py-2 text-sm outline-none focus:border-provo-pass"
              >
                <option value="us-east">us-east</option>
                <option value="us-west">us-west</option>
                <option value="eu-west">eu-west</option>
                <option value="eu-central">eu-central</option>
                <option value="asia-southeast">asia-southeast</option>
                <option value="asia-northeast">asia-northeast</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-provo-muted" htmlFor="claimedTokPerSec">
              Claimed throughput (tok/s)
            </label>
            <input
              id="claimedTokPerSec"
              type="number"
              step="0.1"
              value={claimedTokPerSec}
              onChange={(e) => setClaimedTokPerSec(e.target.value)}
              className="mt-1 w-full rounded-lg border border-provo-border bg-provo-bg px-3 py-2 text-sm outline-none focus:border-provo-pass"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-provo-muted" htmlFor="pricePerHour">
              Price per hour (MON)
            </label>
            <input
              id="pricePerHour"
              type="number"
              step="0.001"
              value={pricePerHour}
              onChange={(e) => setPricePerHour(e.target.value)}
              className="mt-1 w-full rounded-lg border border-provo-border bg-provo-bg px-3 py-2 text-sm outline-none focus:border-provo-pass"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-provo-muted" htmlFor="stake">
              Stake (MON)
            </label>
            <input
              id="stake"
              type="number"
              step="0.01"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              className="mt-1 w-full rounded-lg border border-provo-border bg-provo-bg px-3 py-2 text-sm outline-none focus:border-provo-pass"
            />
          </div>

          {error && <p className="text-sm text-provo-fail">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-provo-pass px-4 py-2.5 text-sm font-semibold text-provo-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Create Listing"}
          </button>

          {txHash && <p className="break-all text-xs text-provo-muted">Tx: {txHash}</p>}
        </form>
      )}

      {address && myListings.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Your listings</h2>
          <div className="mt-4 space-y-3">
            {myListings.map((l) => (
              <div key={l.id.toString()} className="flex items-center justify-between rounded-xl border border-provo-border bg-provo-surface p-4">
                <div>
                  <p className="font-medium">
                    #{l.id.toString()} · {l.gpuModel} · {formatTokPerSec(l.claimedTokPerSec)} tok/s
                  </p>
                  <p className="text-xs text-provo-muted">
                    Stake: {formatMon(l.stake)} MON · {l.passedJobs.toString()}/{l.totalJobs.toString()} passed
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <ReputationBadge scoreBps={l.reputationBps} />
                  <button
                    type="button"
                    onClick={() => handleWithdraw(l.id)}
                    disabled={busy}
                    className="rounded-lg border border-provo-border px-3 py-1.5 text-xs font-medium hover:border-provo-fail/60 hover:text-provo-fail disabled:opacity-50"
                  >
                    Withdraw stake
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
