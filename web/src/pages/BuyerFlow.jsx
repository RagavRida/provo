import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { decodeEventLog } from "viem";
import { CONTRACT_ADDRESS, PROVO_MARKETPLACE_ABI, formatTokPerSec, bpsToPercent } from "../lib/contract";
import { formatMon } from "../lib/format";
import { StatusBadge } from "../components/StatusBadge";
import { writeSync } from "../lib/txHelpers";

const STEPS = ["Browse", "Fund", "Status", "Receipt"];

export function BuyerFlow({ address, publicClient, walletClient, onConnect }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const listingIdParam = searchParams.get("listingId") || "";

  const [listingId, setListingId] = useState(listingIdParam);
  const [listing, setListing] = useState(null);
  const [hours, setHours] = useState("1");
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [step, setStep] = useState(0);
  const [txHash, setTxHash] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (listingIdParam) setListingId(listingIdParam);
  }, [listingIdParam]);

  useEffect(() => {
    if (!listingId) {
      setListing(null);
      return;
    }
    let cancelled = false;
    publicClient
      .readContract({
        address: CONTRACT_ADDRESS,
        abi: PROVO_MARKETPLACE_ABI,
        functionName: "getListing",
        args: [BigInt(listingId)],
      })
      .then((result) => {
        if (!cancelled) setListing(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.shortMessage || err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [listingId, publicClient]);

  const escrowAmount = useMemo(() => {
    if (!listing) return 0n;
    const hrs = Number(hours) || 0;
    return (listing.pricePerHour * BigInt(Math.round(hrs * 1000))) / 1000n;
  }, [listing, hours]);

  function extractJobFundedId(logs) {
    for (const log of logs) {
      if (log.address.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: PROVO_MARKETPLACE_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "JobFunded") return decoded.args.jobId;
      } catch {
        // not a JobFunded log (or not decodable with this ABI slice) — skip
      }
    }
    return null;
  }

  async function handleFund() {
    setError(null);
    setBusy(true);
    try {
      if (!address) await onConnect();

      const writeParams = {
        address: CONTRACT_ADDRESS,
        abi: PROVO_MARKETPLACE_ABI,
        functionName: "fundJob",
        args: [BigInt(listingId)],
        value: escrowAmount,
        account: address,
      };

      // Prefer Monad's eth_sendRawTransactionSync (via viem's writeContractSync) —
      // submits the tx and gets the receipt back in one round-trip instead of
      // writeContract + a separate waitForTransactionReceipt poll. Falls back
      // automatically if the connected RPC doesn't support it.
      let receipt = await writeSync(walletClient, writeParams);
      if (receipt) {
        setTxHash(receipt.transactionHash);
      } else {
        const { request } = await publicClient.simulateContract(writeParams);
        const hash = await walletClient.writeContract(request);
        setTxHash(hash);
        setStep(2);
        receipt = await publicClient.waitForTransactionReceipt({ hash });
      }

      setStep(2);

      // Decode the JobFunded event this transaction emitted to get the
      // authoritative jobId, rather than guessing from nextJobId (which
      // could race with another buyer's concurrent fundJob call).
      const fundedJobId = extractJobFundedId(receipt.logs);
      if (fundedJobId !== null) {
        setJobId(fundedJobId.toString());
      } else {
        setError("Funded, but couldn't decode the job ID from the transaction receipt. Check the explorer.");
      }
    } catch (err) {
      setError(err.shortMessage || err.message || "Funding failed.");
    } finally {
      setBusy(false);
    }
  }

  // Subscribe to the JobSettled event for this specific job instead of
  // polling getJob on an interval — the contract emits events precisely so a
  // frontend can watch instead of poll (see monad-concepts: prefer real-time
  // event sources over repeated eth_call / JSON-RPC polling on a
  // ~10,000 tps chain).
  useEffect(() => {
    if (!jobId) return undefined;

    let cancelled = false;

    // Fetch current state once immediately (covers the case where the job
    // was already settled before this listener attached).
    publicClient
      .readContract({
        address: CONTRACT_ADDRESS,
        abi: PROVO_MARKETPLACE_ABI,
        functionName: "getJob",
        args: [BigInt(jobId)],
      })
      .then((result) => {
        if (cancelled) return;
        setJob(result);
        if (result.status === 2) setStep(3);
      })
      .catch(() => {
        // job not indexed yet at this block — the event watcher below will catch it
      });

    const unwatch = publicClient.watchContractEvent({
      address: CONTRACT_ADDRESS,
      abi: PROVO_MARKETPLACE_ABI,
      eventName: "JobSettled",
      args: { jobId: BigInt(jobId) },
      onLogs: async () => {
        if (cancelled) return;
        try {
          const result = await publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: PROVO_MARKETPLACE_ABI,
            functionName: "getJob",
            args: [BigInt(jobId)],
          });
          if (!cancelled) {
            setJob(result);
            setStep(3);
          }
        } catch (err) {
          if (!cancelled) setError(err.shortMessage || err.message || "Failed to read settled job.");
        }
      },
    });

    return () => {
      cancelled = true;
      unwatch();
    };
  }, [jobId, publicClient]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Buy Compute</h1>
      <p className="mt-2 text-sm text-provo-muted">
        Fund a job against a listing, then watch it get verified and auto-settled on-chain.
      </p>

      <ol className="mt-6 flex items-center gap-2 text-xs">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 font-medium ${
              i === step ? "bg-provo-pass/15 text-provo-pass ring-1 ring-inset ring-provo-pass/40" : "text-provo-muted"
            }`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <div className="mt-8 rounded-xl border border-provo-border bg-provo-surface p-6">
        <label className="block text-sm font-medium text-provo-muted" htmlFor="listingId">
          Listing ID
        </label>
        <input
          id="listingId"
          type="number"
          min="1"
          value={listingId}
          onChange={(e) => {
            setListingId(e.target.value);
            setSearchParams(e.target.value ? { listingId: e.target.value } : {});
          }}
          className="mt-1 w-full rounded-lg border border-provo-border bg-provo-bg px-3 py-2 text-sm outline-none focus:border-provo-pass"
          placeholder="e.g. 1"
        />

        {listing && (
          <div className="mt-4 space-y-1 rounded-lg border border-provo-border bg-provo-bg p-4 text-sm">
            <p>
              <span className="text-provo-muted">GPU:</span> {listing.gpuModel}
            </p>
            <p>
              <span className="text-provo-muted">Claimed:</span> {formatTokPerSec(listing.claimedTokPerSec)} tok/s
            </p>
            <p>
              <span className="text-provo-muted">Price:</span> {formatMon(listing.pricePerHour)} MON/hr
            </p>
          </div>
        )}

        <label className="mt-4 block text-sm font-medium text-provo-muted" htmlFor="hours">
          Hours to fund
        </label>
        <input
          id="hours"
          type="number"
          min="0.1"
          step="0.1"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="mt-1 w-full rounded-lg border border-provo-border bg-provo-bg px-3 py-2 text-sm outline-none focus:border-provo-pass"
        />

        {listing && (
          <p className="mt-2 text-xs text-provo-muted">
            Escrow to be paid: <span className="text-provo-text">{formatMon(escrowAmount)} MON</span>
          </p>
        )}

        {error && <p className="mt-3 text-sm text-provo-fail">{error}</p>}

        <button
          type="button"
          onClick={handleFund}
          disabled={!listing || busy}
          className="mt-5 w-full rounded-lg bg-provo-pass px-4 py-2.5 text-sm font-semibold text-provo-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Submitting…" : address ? "Fund Job" : "Connect Wallet to Fund"}
        </button>

        {txHash && (
          <p className="mt-3 break-all text-xs text-provo-muted">
            Tx: <span className="text-provo-text">{txHash}</span>
          </p>
        )}
      </div>

      {job && (
        <div className="mt-6 rounded-xl border border-provo-border bg-provo-surface p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Settlement Receipt</h2>
            <StatusBadge passed={job.status === 2 ? job.passed : null} />
          </div>
          {listing && (
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-provo-muted">Claimed</dt>
              <dd className="text-right font-medium">{formatTokPerSec(listing.claimedTokPerSec)} tok/s</dd>
              <dt className="text-provo-muted">Measured</dt>
              <dd className="text-right font-medium">
                {job.status === 2 ? formatTokPerSec(job.measuredTokPerSec) : "—"} tok/s
              </dd>
              <dt className="text-provo-muted">Success rate</dt>
              <dd className="text-right font-medium">{job.status === 2 ? `${bpsToPercent(job.measuredSuccessBps)}%` : "—"}</dd>
              <dt className="text-provo-muted">Slashed from provider</dt>
              <dd className={`text-right font-medium ${job.slashedAmount > 0n ? "text-provo-fail" : ""}`}>
                {formatMon(job.slashedAmount)} MON
              </dd>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
