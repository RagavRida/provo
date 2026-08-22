/**
 * GPU benchmark module — measures real inference performance against an
 * OpenAI-compatible /v1/completions endpoint (vLLM, TGI, Ollama, etc.).
 *
 * Returns the same metrics the oracle needs to submit on-chain:
 *   - tokPerSec:    output tokens / generation time (scaled by 1e6 for the contract)
 *   - latencyMs:    time to first token, p50 across runs
 *   - successBps:   fraction of runs that completed without error (0-10000 BPS)
 *
 * Usage:
 *   import { benchmark } from "./benchmark.js";
 *   const result = await benchmark("http://provider:8000", { runs: 3 });
 *   // { tokPerSec: 95.2, latencyMs: 142, successBps: 10000 }
 */

const DEFAULT_PROMPT = "Explain the concept of proof of stake in blockchain in simple terms.";
const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_RUNS = 3;

/**
 * Run a single inference request against an OpenAI-compatible endpoint.
 * Returns { outputTokens, durationMs, ttftMs } on success, or null on failure.
 */
async function runSingleBenchmark(endpointUrl, { prompt, maxTokens }) {
  const url = `${endpointUrl.replace(/\/+$/, "")}/v1/completions`;

  const start = performance.now();
  let ttftMs = null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "default",
        prompt,
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000), // 30s timeout
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`  [benchmark] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const end = performance.now();
    const durationMs = end - start;

    // Extract output tokens — different providers format this differently
    const usage = data.usage;
    const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;

    if (outputTokens === 0) {
      console.warn("  [benchmark] Response had 0 output tokens.");
      return null;
    }

    // TTFT: for non-streaming, approximate as the full request time
    // (accurate TTFT requires streaming, which we add in production)
    ttftMs = durationMs;

    return { outputTokens, durationMs, ttftMs };
  } catch (err) {
    console.warn(`  [benchmark] Request failed: ${err.message}`);
    return null;
  }
}

/**
 * Benchmark an inference endpoint with multiple runs and aggregate.
 *
 * @param {string} endpointUrl  Base URL (e.g. "http://10.0.1.5:8000")
 * @param {object} [opts]
 * @param {string} [opts.prompt]     Prompt to send
 * @param {number} [opts.maxTokens]  Max tokens to generate
 * @param {number} [opts.runs]       Number of benchmark runs
 * @returns {{ tokPerSec: number, latencyMs: number, successBps: number }}
 */
export async function benchmark(endpointUrl, opts = {}) {
  const prompt = opts.prompt ?? DEFAULT_PROMPT;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const runs = opts.runs ?? DEFAULT_RUNS;

  console.log(`  [benchmark] Running ${runs} benchmarks against ${endpointUrl}…`);

  const results = [];
  for (let i = 0; i < runs; i++) {
    const result = await runSingleBenchmark(endpointUrl, { prompt, maxTokens });
    results.push(result);

    // Small delay between runs to avoid rate limiting
    if (i < runs - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const successes = results.filter((r) => r !== null);
  const successBps = Math.round((successes.length / runs) * 10_000);

  if (successes.length === 0) {
    console.warn("  [benchmark] All runs failed.");
    return { tokPerSec: 0, latencyMs: 0, successBps: 0 };
  }

  // tok/s: total tokens / total time across successful runs
  const totalTokens = successes.reduce((s, r) => s + r.outputTokens, 0);
  const totalTimeMs = successes.reduce((s, r) => s + r.durationMs, 0);
  const tokPerSec = (totalTokens / totalTimeMs) * 1000;

  // Latency: p50 of TTFT across successful runs
  const latencies = successes.map((r) => r.ttftMs).sort((a, b) => a - b);
  const p50Index = Math.floor(latencies.length / 2);
  const latencyMs = Math.round(latencies[p50Index]);

  console.log(
    `  [benchmark] Results: ${tokPerSec.toFixed(1)} tok/s, ` +
      `${latencyMs}ms p50 latency, ` +
      `${successes.length}/${runs} successful (${(successBps / 100).toFixed(0)}%)`
  );

  return { tokPerSec, latencyMs, successBps };
}
