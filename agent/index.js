#!/usr/bin/env node
/**
 * Provo benchmark agent.
 *
 * Runs an identical prompt against 2-3 GPU provider endpoints (OpenAI-
 * compatible chat/completions API), measures latency, estimates tok/s, and
 * computes success rate across multiple runs per provider. Outputs:
 *   1. A comparison table sorted by *effective* cost per million tokens
 *      (adjusted for measured throughput + reliability, not sticker price).
 *   2. The exact JSON payload the oracle would submit on-chain for the
 *      winning (or a chosen) provider via submitVerification.
 *
 * Usage:
 *   node index.js            # live mode, hits real provider endpoints
 *   node index.js --mock     # simulated mode, clearly labeled as such
 */

import { readFile } from "node:fs/promises";
import { MOCK_RUNS } from "./mockData.js";

const isMock = process.argv.includes("--mock");
const CONFIG_PATH = new URL("./providers.json", import.meta.url);

async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

/**
 * Calls an OpenAI-compatible /chat/completions endpoint once and measures
 * wall-clock latency + estimates tokens/sec from the response.
 */
async function runLiveRequest(provider, prompt, maxTokens) {
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `Missing ${provider.apiKeyEnv} in environment for provider "${provider.id}". Use --mock to run without live accounts.`
    );
  }

  const start = performance.now();
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  const elapsedMs = performance.now() - start;

  if (!res.ok) {
    return { tokPerSec: 0, latencyMs: elapsedMs, success: false };
  }

  const data = await res.json();
  const completionTokens = data?.usage?.completion_tokens ?? 0;
  const tokPerSec = completionTokens > 0 ? completionTokens / (elapsedMs / 1000) : 0;

  return { tokPerSec, latencyMs: elapsedMs, success: completionTokens > 0 };
}

async function runProviderBenchmark(provider, config) {
  const runs = [];

  if (isMock) {
    const mocked = MOCK_RUNS[provider.id] ?? [];
    runs.push(...mocked);
  } else {
    for (let i = 0; i < config.runsPerProvider; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await runLiveRequest(provider, config.prompt, config.maxTokens);
        runs.push(result);
      } catch (err) {
        runs.push({ tokPerSec: 0, latencyMs: 0, success: false, error: err.message });
      }
    }
  }

  return summarize(provider, runs);
}

function summarize(provider, runs) {
  const successfulRuns = runs.filter((r) => r.success);
  const successRate = runs.length > 0 ? successfulRuns.length / runs.length : 0;

  const avg = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const avgTokPerSec = avg(successfulRuns.map((r) => r.tokPerSec));
  const avgLatencyMs = avg(runs.map((r) => r.latencyMs));

  // Effective cost per million tokens, adjusted for measured throughput AND
  // reliability. A provider that's cheap per hour but slow or flaky ends up
  // costing more per useful million tokens than the sticker price suggests.
  //
  // effectiveCostPerMTok = (pricePerHour / 3600) / tokPerSec * 1e6 / successRate
  let effectiveCostPerMTok = Infinity;
  if (avgTokPerSec > 0 && successRate > 0) {
    const costPerSecond = provider.pricePerHour / 3600;
    const costPerToken = costPerSecond / avgTokPerSec;
    effectiveCostPerMTok = (costPerToken * 1_000_000) / successRate;
  }

  return {
    id: provider.id,
    label: provider.label,
    gpuModel: provider.gpuModel,
    pricePerHour: provider.pricePerHour,
    runs,
    avgTokPerSec,
    avgLatencyMs,
    successRate,
    effectiveCostPerMTok,
  };
}

function printComparisonTable(results) {
  const sorted = [...results].sort((a, b) => a.effectiveCostPerMTok - b.effectiveCostPerMTok);
  const cheapestBySticker = [...results].sort((a, b) => a.pricePerHour - b.pricePerHour)[0];
  const cheapestByEffective = sorted[0];

  console.log(isMock ? "\n[MOCK MODE — simulated, pre-recorded numbers, not live measurements]\n" : "\n[LIVE MODE]\n");
  console.log("Comparison — sorted by EFFECTIVE cost per million tokens (not sticker price):\n");

  const rows = sorted.map((r, i) => ({
    rank: i + 1,
    provider: r.label,
    gpu: r.gpuModel,
    sticker: `$${r.pricePerHour.toFixed(2)}/hr`,
    measuredTokS: r.avgTokPerSec.toFixed(1),
    avgLatencyMs: r.avgLatencyMs.toFixed(0),
    successRate: `${(r.successRate * 100).toFixed(0)}%`,
    effectiveCostPerMTok: Number.isFinite(r.effectiveCostPerMTok) ? `$${r.effectiveCostPerMTok.toFixed(3)}` : "N/A",
  }));

  console.table(rows);

  if (cheapestBySticker.id !== cheapestByEffective.id) {
    console.log(
      `\nAdvertised cheapest: ${cheapestBySticker.label} ($${cheapestBySticker.pricePerHour.toFixed(2)}/hr)\n` +
        `Actually cheapest (effective): ${cheapestByEffective.label} ($${cheapestByEffective.effectiveCostPerMTok.toFixed(
          3
        )}/M tok)\n` +
        `--> Sticker price and effective cost DIVERGE. This is the core Provo insight.\n`
    );
  } else {
    console.log(`\nAdvertised cheapest and actually-cheapest agree in this run: ${cheapestBySticker.label}.\n`);
  }

  return sorted;
}

/**
 * Builds the exact payload the oracle bridge would submit on-chain via
 * submitVerification(jobId, measuredTokPerSec, measuredLatencyMs, measuredSuccessBps).
 *
 * measuredTokPerSec is scaled by 1e6 to match the claimedTokPerSec scaling
 * used in ProvoMarketplace.sol (avoids fixed-point math on-chain).
 */
function buildOraclePayload(result, jobId) {
  return {
    jobId,
    measuredTokPerSec: Math.round(result.avgTokPerSec * 1_000_000),
    measuredLatencyMs: Math.round(result.avgLatencyMs),
    measuredSuccessBps: Math.round(result.successRate * 10_000),
  };
}

async function main() {
  const config = await loadConfig();

  console.log(`Prompt: "${config.prompt}"`);
  console.log(`Runs per provider: ${config.runsPerProvider}`);
  console.log(`Providers: ${config.providers.map((p) => p.label).join(", ")}`);

  const results = [];
  for (const provider of config.providers) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runProviderBenchmark(provider, config);
    results.push(result);
  }

  const sorted = printComparisonTable(results);

  console.log("Oracle payload (for the actually-cheapest / top-ranked provider):\n");
  // jobId is a placeholder here — the real jobId comes from the on-chain
  // JobFunded event once a buyer has called fundJob() for this listing.
  const payload = buildOraclePayload(sorted[0], "<jobId-from-JobFunded-event>");
  console.log(JSON.stringify(payload, null, 2));

  console.log(
    "\nAll providers' oracle-ready payloads:\n" +
      JSON.stringify(
        sorted.map((r) => ({ provider: r.id, ...buildOraclePayload(r, "<jobId>") })),
        null,
        2
      )
  );
}

main().catch((err) => {
  console.error("Benchmark agent failed:", err);
  process.exitCode = 1;
});
