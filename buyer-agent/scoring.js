/**
 * Pure scoring logic for the autonomous buyer agent.
 *
 * Kept dependency-free and side-effect-free so it can be unit tested without
 * a chain (see scoring.test.js).
 *
 * Scoring formula (v2):
 *   adjustedCost = baseCostPerTok * (BPS / repBps) * (BPS / stakeConfBps) [* latencyPenalty]
 *
 * Lower adjustedCost = better listing.
 */

export const TOK_SCALE = 1_000_000n; // claimedTokPerSec is scaled by 1e6 on-chain
export const BPS = 10_000n;

/** New providers with zero settled jobs get a neutral prior instead of being excluded. */
export const NEUTRAL_PRIOR_BPS = 7_500n; // 75%

/**
 * Floor applied to a provider that has real history but a 0% pass rate.
 * They stay technically eligible (the spec only excludes on hard filters),
 * but the divisor floor pushes their adjusted cost far down the ranking.
 */
export const MIN_REP_BPS = 100n; // 1%

/**
 * Floor for stake confidence. A listing with zero stake gets this floor
 * rather than a divide-by-zero. 10% means zero-stake providers are scored
 * as if they cost 10x more than a fully-staked one.
 */
export const STAKE_CONFIDENCE_FLOOR_BPS = 1_000n; // 10%

/**
 * Latency baseline in ms. At or below this, no penalty.
 * Above this, penalty increases linearly.
 */
export const LATENCY_BASELINE_MS = 100n;

/**
 * How aggressively latency penalises. Every LATENCY_SCALE_MS ms above
 * the baseline adds 1x to the penalty (i.e. at baseline + scale, penalty = 2x).
 */
export const LATENCY_SCALE_MS = 200n;

/**
 * Same-region bonus. When the buyer sets --prefer-region and a listing matches,
 * its score is divided by (BPS + REGION_MATCH_BONUS_BPS) / BPS — effectively
 * a 20% discount in scoring. Not a hard filter; cross-region listings remain
 * eligible, just ranked lower.
 */
export const REGION_MATCH_BONUS_BPS = 2_000n; // 20%

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * Effective cost, before reputation: wei per (tok/s) per hour.
 * Lower is better.
 */
export function baseCostPerTokPerSec(pricePerHour, claimedTokPerSec) {
  if (claimedTokPerSec === 0n) return null; // unusable claim
  return (pricePerHour * TOK_SCALE) / claimedTokPerSec;
}

/**
 * Reputation used for scoring: the on-chain pass rate, or a neutral prior when
 * the provider has no settled jobs yet.
 */
export function effectiveReputationBps(listing, reputationBps) {
  if (listing.totalJobs === 0n) return NEUTRAL_PRIOR_BPS;
  return reputationBps < MIN_REP_BPS ? MIN_REP_BPS : reputationBps;
}

/**
 * Stake confidence: how much the provider has staked relative to the job cost.
 *
 * stakeRatio = stake / pricePerHour  (for a 1-hour job baseline)
 *
 * A provider staking 1x their hourly rate → 100% confidence (no penalty).
 * A provider staking 0.1x → ~10% confidence → scored as 10x more expensive.
 * A provider staking 5x → capped at 100% (no bonus beyond 1x).
 *
 * The durationHours parameter isn't used in the ratio — stake is compared to
 * the hourly rate as a fixed "commitment per unit of work" metric, independent
 * of how many hours the buyer wants. This prevents long jobs from artificially
 * deflating every provider's confidence score.
 */
export function stakeConfidenceBps(stake, pricePerHour) {
  if (pricePerHour === 0n) return BPS; // free listing — stake irrelevant
  const ratio = (stake * BPS) / pricePerHour;
  if (ratio >= BPS) return BPS;
  if (ratio < STAKE_CONFIDENCE_FLOOR_BPS) return STAKE_CONFIDENCE_FLOOR_BPS;
  return ratio;
}

/**
 * Latency penalty multiplier in BPS.
 *
 * At or below LATENCY_BASELINE_MS: returns BPS (1x, no penalty).
 * Above baseline: linear increase. At baseline + LATENCY_SCALE_MS, returns 2 * BPS.
 *
 * Returns BPS (neutral) when no latency data is available (null/undefined/0).
 */
export function latencyPenaltyBps(avgLatencyMs) {
  if (avgLatencyMs == null || avgLatencyMs === 0n) return BPS;
  const ms = BigInt(avgLatencyMs);
  if (ms <= LATENCY_BASELINE_MS) return BPS;
  return BPS + ((ms - LATENCY_BASELINE_MS) * BPS) / LATENCY_SCALE_MS;
}

// ---------------------------------------------------------------------------
// Combined scoring
// ---------------------------------------------------------------------------

/**
 * Reputation-adjusted cost with stake confidence and optional latency penalty.
 *
 * adjustedCost = baseCost * (BPS / repBps) * (BPS / stakeConfBps) [* (latPenBps / BPS)]
 *
 * Lower score = better. Returns null if the listing can't be scored.
 *
 * @param {object}  listing           On-chain listing data
 * @param {bigint}  reputationBps     On-chain reputation (0–10000)
 * @param {object}  [opts]            Optional scoring parameters
 * @param {boolean} [opts.latencySensitive]  Whether to apply latency penalty
 * @param {bigint}  [opts.avgLatencyMs]      Historical avg latency for this listing
 */
export function scoreListing(listing, reputationBps, opts = {}) {
  const base = baseCostPerTokPerSec(listing.pricePerHour, listing.claimedTokPerSec);
  if (base === null) return null;

  const repBps = effectiveReputationBps(listing, reputationBps);
  const stakeConf = stakeConfidenceBps(listing.stake, listing.pricePerHour);

  // Base * reputation penalty * stake penalty
  let score = (base * BPS) / repBps;
  score = (score * BPS) / stakeConf;

  // Latency penalty (only when the workload cares)
  if (opts.latencySensitive) {
    const latPen = latencyPenaltyBps(opts.avgLatencyMs);
    score = (score * latPen) / BPS;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Filters listings down to the ones this agent is allowed to fund, then ranks
 * them best-first.
 *
 * Eligibility rules (all must hold):
 *  - listing is active
 *  - claimed throughput meets the workload's minimum requirement
 *  - listing has not already been tried in this session
 *  - the cost of one job would not breach the remaining spend allowance
 *  - GPU VRAM >= minVramGb (hard filter, if specified)
 *
 * Scoring modifiers:
 *  - reputation (always)
 *  - stake-to-claim ratio (always)
 *  - latency penalty (only when latencySensitive = true)
 *  - region match bonus (only when preferRegion is set)
 *
 * @param {object}  params
 * @param {Array}   params.listings             Array of { id, listing, reputationBps }
 * @param {bigint}  params.minTokPerSec         Minimum claimed tok/s (scaled by 1e6)
 * @param {Set}     params.triedListingIds      IDs already attempted this session
 * @param {bigint}  params.remainingBudgetWei   How much more the agent may spend
 * @param {Function} params.jobCostFor          (listing) => bigint cost in wei
 * @param {boolean} [params.latencySensitive]   Whether latency affects scoring
 * @param {Map}     [params.latencyByListingId] Map<string, bigint> avg latency ms per listing
 * @param {bigint}  [params.minVramGb]          Minimum VRAM in GB (hard filter)
 * @param {string}  [params.preferRegion]       Preferred region (soft bonus)
 */
export function rankEligibleListings({
  listings,
  minTokPerSec,
  triedListingIds,
  remainingBudgetWei,
  jobCostFor,
  latencySensitive = false,
  latencyByListingId = new Map(),
  minVramGb = 0n,
  preferRegion = null,
}) {
  const eligible = [];

  for (const entry of listings) {
    const { id, listing, reputationBps } = entry;

    if (!listing.active) continue;
    if (listing.claimedTokPerSec < minTokPerSec) continue;
    if (triedListingIds.has(id.toString())) continue;

    // VRAM hard filter — a model that doesn't fit in VRAM fails regardless of tok/s
    if (minVramGb > 0n && (listing.vramGb ?? 0n) < minVramGb) continue;

    const cost = jobCostFor(listing);
    if (cost > remainingBudgetWei) continue;

    let score = scoreListing(listing, reputationBps, {
      latencySensitive,
      avgLatencyMs: latencyByListingId.get(id.toString()),
    });
    if (score === null) continue;

    // Region soft bonus — same-region gets a 20% effective discount
    if (preferRegion && listing.region && listing.region.toLowerCase() === preferRegion.toLowerCase()) {
      score = (score * BPS) / (BPS + REGION_MATCH_BONUS_BPS);
    }

    eligible.push({ id, listing, reputationBps, score, cost });
  }

  // Best (lowest) score first; tie-break on lower absolute cost for determinism.
  eligible.sort((a, b) => {
    if (a.score !== b.score) return a.score < b.score ? -1 : 1;
    if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  return eligible;
}
