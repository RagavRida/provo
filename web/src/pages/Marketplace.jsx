import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CONTRACT_ADDRESS, PROVO_MARKETPLACE_ABI, formatTokPerSec } from "../lib/contract";
import { formatMon } from "../lib/format";
import { ReputationBadge } from "../components/StatusBadge";

/**
 * Computes effective cost per hour of *useful* throughput — the marketplace
 * sorts by this, not by the raw pricePerHour sticker price, so a listing
 * that claims high tok/s at a slightly higher price can rank above a
 * cheaper listing with a weaker claim.
 */
function effectiveScore(listing) {
  const tokPerSec = Number(listing.claimedTokPerSec) / 1_000_000;
  if (tokPerSec <= 0) return Infinity;
  const priceEth = Number(formatMon(listing.pricePerHour));
  return priceEth / tokPerSec;
}

export function Marketplace({ publicClient }) {
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    // Retry wrapper — the public Monad testnet RPC rate-limits concurrent
    // requests, so a bare readContract can fail transiently. Two retries with
    // exponential backoff keeps the marketplace page reliable for demos.
    async function retryRead(fn, retries = 2, delayMs = 400) {
      for (let i = 0; i <= retries; i++) {
        try {
          return await fn();
        } catch (err) {
          if (i === retries) throw err;
          await new Promise((r) => setTimeout(r, delayMs * 2 ** i));
        }
      }
    }

    async function readOneListing(id) {
      const [listing, reputationBps] = await Promise.all([
        retryRead(() =>
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: PROVO_MARKETPLACE_ABI,
            functionName: "getListing",
            args: [id],
          })
        ),
        retryRead(() =>
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: PROVO_MARKETPLACE_ABI,
            functionName: "reputationScoreBps",
            args: [id],
          })
        ),
      ]);
      return { id, ...listing, reputationBps };
    }

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const nextId = await retryRead(() =>
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: PROVO_MARKETPLACE_ABI,
            functionName: "nextListingId",
          })
        );

        const ids = Array.from({ length: Number(nextId) - 1 }, (_, i) => BigInt(i + 1));

        // Try parallel first; fall back to sequential if the RPC throttles.
        let results;
        try {
          results = await Promise.all(ids.map(readOneListing));
        } catch {
          results = [];
          for (const id of ids) {
            results.push(await readOneListing(id));
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        if (!cancelled) {
          setListings(results.filter((l) => l.active).sort((a, b) => effectiveScore(a) - effectiveScore(b)));
        }
      } catch (err) {
        if (!cancelled) setError(err.shortMessage || err.message || "Failed to load listings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Marketplace</h1>
        <p className="mt-2 max-w-2xl text-sm text-provo-muted">
          Listings sorted by effective cost per verified token-per-second — not sticker price. Every claim here is
          backed by staked MON and settled automatically against a measured benchmark.
        </p>
      </div>

      {loading && <p className="text-sm text-provo-muted">Loading listings…</p>}
      {error && <p className="text-sm text-provo-fail">{error}</p>}
      {!loading && !error && listings.length === 0 && (
        <p className="text-sm text-provo-muted">
          No active listings yet. <Link to="/provide" className="text-provo-pass underline">Create one</Link>.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {listings.map((listing) => (
          <div
            key={listing.id.toString()}
            className="rounded-xl border border-provo-border bg-provo-surface p-5 transition-colors hover:border-provo-pass/40"
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold">{listing.gpuModel}</h2>
                <p className="text-xs text-provo-muted">Listing #{listing.id.toString()}</p>
              </div>
              <ReputationBadge scoreBps={listing.reputationBps} />
            </div>

            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-provo-muted">Claimed throughput</dt>
                <dd className="font-medium">{formatTokPerSec(listing.claimedTokPerSec)} tok/s</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-provo-muted">VRAM</dt>
                <dd className="font-medium">{listing.vramGb?.toString() ?? "—"} GB</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-provo-muted">Region</dt>
                <dd className="font-medium">
                  <span className="rounded-md bg-provo-border/50 px-2 py-0.5 text-xs">{listing.region || "—"}</span>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-provo-muted">Price</dt>
                <dd className="font-medium">{formatMon(listing.pricePerHour)} MON/hr</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-provo-muted">Provider stake</dt>
                <dd className="font-medium">{formatMon(listing.stake)} MON</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-provo-muted">Track record</dt>
                <dd className="font-medium">
                  {listing.passedJobs.toString()}/{listing.totalJobs.toString()} passed
                </dd>
              </div>
            </dl>

            <Link
              to={`/buy?listingId=${listing.id.toString()}`}
              className="mt-5 block rounded-lg bg-provo-pass px-4 py-2 text-center text-sm font-semibold text-provo-bg transition-opacity hover:opacity-90"
            >
              Fund a job
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
