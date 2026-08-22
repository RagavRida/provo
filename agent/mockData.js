// Pre-recorded, clearly-simulated numbers for --mock mode, used when live
// provider accounts aren't available for a demo. These are illustrative and
// deliberately reproduce the "identical H100s, different real-world
// performance" premise: same advertised spec, materially different delivered
// throughput/latency/reliability driven by cooling, config, and wear.
export const MOCK_RUNS = {
  // Cheapest advertised sticker price ($1.50/hr) but noticeably weaker
  // delivered throughput — the "identical H100, worse cooling/config/wear"
  // case the whole product exists to catch.
  "alpha-cloud": [
    { tokPerSec: 62.3, latencyMs: 1180, success: true },
    { tokPerSec: 59.8, latencyMs: 1240, success: true },
    { tokPerSec: 61.1, latencyMs: 1205, success: true },
  ],
  // Mid sticker price ($1.80/hr) but the best delivered throughput of the
  // three — this is the provider that's actually cheapest per useful token,
  // even though it's not the cheapest by sticker price.
  "beta-compute": [
    { tokPerSec: 96.4, latencyMs: 760, success: true },
    { tokPerSec: 94.1, latencyMs: 780, success: true },
    { tokPerSec: 95.2, latencyMs: 770, success: true },
  ],
  // Most expensive sticker price ($2.10/hr), decent but unremarkable
  // throughput plus one flaky run — expensive on both axes.
  "gamma-gpu": [
    { tokPerSec: 84.2, latencyMs: 860, success: true },
    { tokPerSec: 83.0, latencyMs: 875, success: true },
    { tokPerSec: 82.4, latencyMs: 890, success: false },
  ],
};
