/**
 * AI reasoning layer for the Provo buyer agent.
 *
 * Uses GPT-4 to analyze marketplace listings and explain purchase decisions
 * in natural language. The LLM doesn't replace the deterministic scoring —
 * it wraps it with human-readable reasoning that streams to the dashboard.
 *
 * Flow: listings → LLM analysis → scored ranking + explanation → execute
 */

const SYSTEM_PROMPT = `You are the AI brain of an autonomous GPU compute buyer agent on the Monad blockchain.

Your job: analyze GPU marketplace listings and recommend the best one for the buyer's workload.

You receive structured listing data (GPU model, VRAM, region, claimed throughput, price, stake, pass/fail history) and the buyer's requirements (min throughput, budget, preferred region, min VRAM).

Your analysis should:
1. Filter out listings that don't meet hard requirements (VRAM too low, throughput too low)
2. Evaluate remaining listings on cost-efficiency, reliability (pass rate), stake confidence, and region match
3. Pick the best listing and explain WHY in 2-3 sentences
4. Flag any risks (low pass rate, suspiciously cheap, under-staked)

Respond in JSON format:
{
  "reasoning": "Brief 2-3 sentence analysis of the market state",
  "recommendation": {
    "listingId": <number>,
    "confidence": "high" | "medium" | "low",
    "explanation": "Why this listing was chosen"
  },
  "risks": ["risk1", "risk2"],
  "rejected": [{"listingId": <number>, "reason": "why rejected"}]
}`;

/**
 * Call GPT-4 to analyze listings and produce a reasoned recommendation.
 *
 * @param {Array} listings - Scored listing objects from the deterministic layer
 * @param {object} workload - Buyer's workload requirements
 * @param {function} [broadcast] - Optional SSE broadcast function
 * @returns {object} AI analysis result
 */
export async function analyzeWithAI(listings, workload, broadcast) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const fallback = {
      reasoning: "AI analysis skipped — no OPENAI_API_KEY configured. Using deterministic scoring only.",
      recommendation: null,
      risks: [],
      rejected: [],
    };
    if (broadcast) broadcast("ai_skip", fallback);
    return fallback;
  }

  const userPrompt = buildUserPrompt(listings, workload);

  if (broadcast) {
    broadcast("ai_thinking", { message: "GPT-4 analyzing marketplace listings…" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`OpenAI API ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) throw new Error("Empty response from GPT-4");

    const analysis = JSON.parse(content);

    if (broadcast) {
      broadcast("ai_analysis", {
        reasoning: analysis.reasoning,
        recommendation: analysis.recommendation,
        risks: analysis.risks,
        rejected: analysis.rejected,
        tokensUsed: data.usage?.total_tokens ?? 0,
      });
    }

    console.log(`  [AI] ${analysis.reasoning}`);
    if (analysis.recommendation) {
      console.log(
        `  [AI] Recommends listing #${analysis.recommendation.listingId} ` +
          `(${analysis.recommendation.confidence} confidence): ${analysis.recommendation.explanation}`
      );
    }
    if (analysis.risks?.length) {
      console.log(`  [AI] Risks: ${analysis.risks.join("; ")}`);
    }

    return analysis;
  } catch (err) {
    console.warn(`  [AI] GPT-4 analysis failed: ${err.message}`);
    const fallback = {
      reasoning: `AI analysis failed: ${err.message}. Falling back to deterministic scoring.`,
      recommendation: null,
      risks: [],
      rejected: [],
    };
    if (broadcast) broadcast("ai_error", { error: err.message });
    return fallback;
  }
}

/**
 * Build a structured prompt from listings and workload requirements.
 */
function buildUserPrompt(listings, workload) {
  const listingsSummary = listings.map((l) => ({
    id: Number(l.id),
    gpuModel: l.gpuModel,
    vramGb: Number(l.vramGb ?? 0),
    region: l.region || "unknown",
    claimedTokPerSec: (Number(l.claimedTokPerSec) / 1e6).toFixed(1),
    pricePerHourMON: (Number(l.pricePerHour) / 1e18).toFixed(4),
    stakeMON: (Number(l.stake) / 1e18).toFixed(4),
    passedJobs: Number(l.passedJobs),
    totalJobs: Number(l.totalJobs),
    passRate: l.totalJobs > 0 ? `${((Number(l.passedJobs) / Number(l.totalJobs)) * 100).toFixed(0)}%` : "no history",
    active: l.active,
  }));

  return JSON.stringify(
    {
      buyerRequirements: {
        minThroughput: `${workload.minTokPerSec} tok/s`,
        maxBudgetMON: (Number(workload.maxTotalSpendWei) / 1e18).toFixed(4),
        preferredRegion: workload.preferRegion || "none",
        minVramGb: workload.minVramGb || "none",
        latencySensitive: workload.latencySensitive || false,
      },
      availableListings: listingsSummary,
    },
    null,
    2
  );
}
