import { useCallback, useEffect, useRef, useState } from "react";

const AGENT_URL = import.meta.env.VITE_AGENT_URL || "http://localhost:3001";
const EXPLORER_TX = "https://testnet.monadscan.com/tx/";

const STATUS_LABELS = {
  idle: "Idle",
  run_started: "Starting",
  read: "Reading Listings",
  score: "Scoring",
  select: "Selected Provider",
  fund_pending: "Funding…",
  fund_confirmed: "Funded",
  watch: "Watching Settlement",
  result_pass: "Passed ✓",
  result_fail: "Failed ✗",
  refund: "Refunded",
  retry: "Re-routing",
  report: "Done",
};

const STATUS_COLORS = {
  idle: "text-provo-muted border-provo-border",
  run_started: "text-blue-400 border-blue-400/40 bg-blue-400/10",
  read: "text-blue-400 border-blue-400/40 bg-blue-400/10",
  score: "text-blue-400 border-blue-400/40 bg-blue-400/10",
  select: "text-provo-pass border-provo-pass/40 bg-provo-pass/10",
  fund_pending: "text-amber-400 border-amber-400/40 bg-amber-400/10",
  fund_confirmed: "text-provo-pass border-provo-pass/40 bg-provo-pass/10",
  watch: "text-blue-400 border-blue-400/40 bg-blue-400/10",
  result_pass: "text-provo-pass border-provo-pass/40 bg-provo-pass/10",
  result_fail: "text-provo-fail border-provo-fail/40 bg-provo-fail/10",
  refund: "text-amber-400 border-amber-400/40 bg-amber-400/10",
  retry: "text-violet-400 border-violet-400/40 bg-violet-400/10",
  report: "text-provo-text border-provo-border bg-provo-surface",
};

function SpendBar({ spent, cap }) {
  const s = parseFloat(spent) || 0;
  const c = parseFloat(cap) || 1;
  const pct = Math.min((s / c) * 100, 100);
  const color = pct > 85 ? "bg-provo-fail" : pct > 60 ? "bg-amber-400" : "bg-provo-pass";
  return (
    <div>
      <div className="flex justify-between text-xs text-provo-muted mb-1">
        <span>Spent</span>
        <span>{spent} / {cap} MON</span>
      </div>
      <div className="h-2 rounded-full bg-provo-border overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function EventCard({ event }) {
  const { type, data, timestamp } = event;
  const time = new Date(timestamp).toLocaleTimeString();

  const baseClass =
    "rounded-xl border px-5 py-4 transition-all duration-300 animate-in";

  if (type === "init") {
    return (
      <div className={`${baseClass} border-blue-400/30 bg-blue-400/5`}>
        <div className="flex items-center gap-2 text-sm font-semibold text-blue-400">
          <span className="text-lg">🤖</span> Agent Initialized
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-provo-muted">
          <span>Wallet</span><span className="text-provo-text font-mono">{data.wallet?.slice(0, 10)}…</span>
          <span>Min throughput</span><span className="text-provo-text">{data.minTokPerSec} tok/s</span>
          <span>Spend cap</span><span className="text-provo-text">{data.spendCap}</span>
          <span>Max retries</span><span className="text-provo-text">{data.maxRetries}</span>
        </div>
      </div>
    );
  }

  if (type === "attempt_start") {
    return (
      <div className={`${baseClass} border-provo-border bg-provo-surface/50`}>
        <span className="text-sm font-semibold text-provo-text">
          ── Attempt {data.attempt}/{data.maxAttempts} ──
        </span>
        <span className="ml-3 text-xs text-provo-muted">{time}</span>
      </div>
    );
  }

  if (type === "score") {
    return (
      <div className={`${baseClass} border-blue-400/30 bg-blue-400/5`}>
        <div className="flex items-center gap-2 text-sm font-semibold text-blue-400">
          <span className="text-lg">📊</span> Scored {data.eligibleCount} Eligible Listing{data.eligibleCount !== 1 ? "s" : ""}
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        {data.listings?.length > 0 && (
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr className="text-provo-muted">
                <th className="text-left font-medium pb-1">#</th>
                <th className="text-left font-medium pb-1">GPU</th>
                <th className="text-right font-medium pb-1">Claimed</th>
                <th className="text-right font-medium pb-1">Price/hr</th>
                <th className="text-right font-medium pb-1">Rep</th>
                <th className="text-right font-medium pb-1">Stake</th>
                {data.listings.some((l) => l.latencyLabel) && (
                  <th className="text-right font-medium pb-1">Latency</th>
                )}
                <th className="text-right font-medium pb-1">Score</th>
              </tr>
            </thead>
            <tbody>
              {data.listings.map((l, i) => (
                <tr key={l.id} className={i === 0 ? "text-provo-pass font-semibold" : "text-provo-text"}>
                  <td className="py-0.5">{i === 0 ? "→ " : "  "}#{l.id}</td>
                  <td>{l.gpuModel}</td>
                  <td className="text-right">{l.claimedTokPerSec} tok/s</td>
                  <td className="text-right">{l.pricePerHour} MON</td>
                  <td className="text-right">{l.reputationLabel}</td>
                  <td className="text-right">{l.stakeLabel || "—"}</td>
                  {data.listings.some((ll) => ll.latencyLabel) && (
                    <td className="text-right">{l.latencyLabel || "—"}</td>
                  )}
                  <td className="text-right font-mono">{BigInt(l.score).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (type === "select") {
    return (
      <div className={`${baseClass} border-provo-pass/40 bg-provo-pass/5`}>
        <div className="flex items-center gap-2 text-sm font-semibold text-provo-pass">
          <span className="text-lg">✅</span> Selected Listing #{data.listingId}
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        <p className="mt-1 text-xs text-provo-muted">
          {data.gpuModel} — {data.claimedTokPerSec} tok/s — Job cost: <span className="text-provo-text">{data.cost}</span>
        </p>
      </div>
    );
  }

  if (type === "fund_pending") {
    return (
      <div className={`${baseClass} border-amber-400/40 bg-amber-400/5 animate-pulse`}>
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-400">
          <span className="text-lg">⏳</span> Funding listing #{data.listingId}…
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        <p className="mt-1 text-xs text-provo-muted">Sending {data.cost} to escrow</p>
      </div>
    );
  }

  if (type === "fund_confirmed") {
    return (
      <div className={`${baseClass} border-provo-pass/40 bg-provo-pass/5`}>
        <div className="flex items-center gap-2 text-sm font-semibold text-provo-pass">
          <span className="text-lg">💰</span> Funded — Job #{data.jobId}
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        <p className="mt-1 text-xs text-provo-muted">
          {data.cost} escrowed · Block #{data.blockNumber} ·{" "}
          <a href={data.explorerUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">
            View on explorer ↗
          </a>
        </p>
      </div>
    );
  }

  if (type === "watch") {
    return (
      <div className={`${baseClass} border-blue-400/30 bg-blue-400/5 animate-pulse`}>
        <div className="flex items-center gap-2 text-sm font-semibold text-blue-400">
          <span className="text-lg">👁️</span> Watching for settlement on Job #{data.jobId}…
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
      </div>
    );
  }

  if (type === "result_pass") {
    return (
      <div className={`${baseClass} border-provo-pass/50 bg-provo-pass/10 ring-1 ring-provo-pass/30`}>
        <div className="flex items-center gap-2 text-sm font-bold text-provo-pass">
          <span className="text-xl">✓</span> PASS — Provider Delivered
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        <p className="mt-2 text-sm text-provo-text">
          Delivered <span className="font-semibold text-provo-pass">{data.measuredTokPerSec} tok/s</span> vs{" "}
          {data.claimedTokPerSec} tok/s claimed. Provider paid {data.cost}.
        </p>
      </div>
    );
  }

  if (type === "result_fail") {
    return (
      <div className={`${baseClass} border-provo-fail/50 bg-provo-fail/10 ring-1 ring-provo-fail/30`}>
        <div className="flex items-center gap-2 text-sm font-bold text-provo-fail">
          <span className="text-xl">✗</span> FAIL — Provider Underdelivered
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        <p className="mt-2 text-sm text-provo-text">
          Delivered only <span className="font-semibold text-provo-fail">{data.measuredTokPerSec} tok/s</span> vs{" "}
          {data.claimedTokPerSec} tok/s claimed. Provider slashed.
        </p>
      </div>
    );
  }

  if (type === "refund") {
    return (
      <div className={`${baseClass} border-amber-400/50 bg-amber-400/10 ring-1 ring-amber-400/30`}>
        <div className="flex items-center gap-2 text-sm font-bold text-amber-400">
          <span className="text-xl">↩️</span> Buyer Refunded + Compensated
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        <p className="mt-2 text-sm text-provo-text">
          Escrow <span className="text-amber-400">{data.escrow}</span> refunded +{" "}
          <span className="text-provo-fail">{data.slashedAmount}</span> slashed from provider ={" "}
          <span className="font-semibold text-provo-pass">{data.totalRecovered}</span> recovered.
        </p>
      </div>
    );
  }

  if (type === "retry") {
    return (
      <div
        className={`${baseClass} border-violet-400/50 bg-violet-400/10 ring-2 ring-violet-400/40`}
        style={{ animation: "pulse 1.5s ease-in-out 3" }}
      >
        <div className="flex items-center gap-2 text-sm font-bold text-violet-400">
          <span className="text-xl">🔄</span> Autonomous Re-Route
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        <p className="mt-2 text-sm text-provo-text">
          Listing #{data.excludedListingId} excluded. Re-scoring remaining providers with{" "}
          <span className="font-semibold">{data.remainingBudget}</span> budget.
        </p>
        <p className="mt-1 text-xs font-semibold text-violet-400">
          No human approval required.
        </p>
      </div>
    );
  }

  if (type === "report") {
    return (
      <div className={`${baseClass} border-2 ${data.success ? "border-provo-pass/60 bg-provo-pass/5" : "border-provo-fail/60 bg-provo-fail/5"}`}>
        <div className="flex items-center gap-2 text-lg font-bold">
          <span className="text-xl">{data.success ? "🏆" : "📋"}</span>
          <span className={data.success ? "text-provo-pass" : "text-provo-fail"}>
            Final Report — {data.status?.toUpperCase()}
          </span>
          <span className="ml-auto text-xs text-provo-muted">{time}</span>
        </div>
        <p className="mt-2 text-sm text-provo-muted">{data.message}</p>
        {data.attempts?.length > 0 && (
          <div className="mt-3 space-y-1">
            {data.attempts.map((a, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className={`h-2 w-2 rounded-full ${a.passed ? "bg-provo-pass" : "bg-provo-fail"}`} />
                <span className="text-provo-text">
                  Listing #{a.listingId} → {a.passed ? "PASS" : "FAIL"} ({a.measuredTokPerSec} tok/s)
                  {a.passed ? ` · paid ${a.cost}` : ` · recovered ${a.recovered}`}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 grid grid-cols-3 gap-3 rounded-lg bg-provo-bg p-3 text-center text-xs">
          <div>
            <div className="text-provo-muted">Net committed</div>
            <div className="mt-0.5 text-sm font-semibold text-provo-text">{data.netCommitted}</div>
          </div>
          <div>
            <div className="text-provo-muted">Recovered</div>
            <div className="mt-0.5 text-sm font-semibold text-provo-pass">{data.recovered}</div>
          </div>
          <div>
            <div className="text-provo-muted">Net position</div>
            <div className={`mt-0.5 text-sm font-semibold ${data.netPosition?.startsWith("+") ? "text-provo-pass" : "text-provo-fail"}`}>
              {data.netPosition}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Fallback for unknown event types
  return (
    <div className={`${baseClass} border-provo-border bg-provo-surface/50`}>
      <span className="text-xs text-provo-muted">{time} — {type}</span>
    </div>
  );
}

export function AgentDashboard() {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [currentRunId, setCurrentRunId] = useState(null);
  const [latestStatus, setLatestStatus] = useState("idle");
  const [spentDisplay, setSpentDisplay] = useState("0.0");
  const [capDisplay, setCapDisplay] = useState("0.05");
  const [attemptInfo, setAttemptInfo] = useState({ current: 0, max: 3 });
  const [error, setError] = useState(null);
  const feedRef = useRef(null);
  const esRef = useRef(null);

  // Auto-scroll feed to bottom on new events
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events]);

  // Connect to SSE stream
  useEffect(() => {
    const es = new EventSource(`${AGENT_URL}/events`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data);

        // Ignore events from a stale run
        if (currentRunId && event.runId && event.runId !== currentRunId) return;

        if (event.type === "connected") {
          if (event.runId) setCurrentRunId(event.runId);
          return;
        }

        if (event.type === "run_started") {
          setCurrentRunId(event.data.runId);
          setAgentRunning(true);
          setLaunching(false);
          setEvents([]);
        }

        if (event.type === "run_finished" || event.type === "run_error") {
          setAgentRunning(false);
        }

        // Update status from event type
        if (STATUS_LABELS[event.type]) {
          setLatestStatus(event.type);
        }

        // Update spend/attempt trackers from event data
        if (event.data) {
          if (event.data.totalSpentWei && event.data.maxTotalSpendWei) {
            const spent = Number(BigInt(event.data.totalSpentWei)) / 1e18;
            const cap = Number(BigInt(event.data.maxTotalSpendWei)) / 1e18;
            setSpentDisplay(spent.toFixed(4));
            setCapDisplay(cap.toFixed(4));
          }
          if (event.data.attemptCount !== undefined) {
            setAttemptInfo({
              current: event.data.attemptCount,
              max: event.data.maxAttempts,
            });
          }
        }

        // Only add visual events to the feed (skip meta events)
        const skipTypes = new Set(["connected", "run_started", "run_finished", "run_error", "spend"]);
        if (!skipTypes.has(event.type)) {
          setEvents((prev) => [...prev, event]);
        }
      } catch {
        // malformed SSE data — skip
      }
    };

    return () => es.close();
  }, [currentRunId]);

  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    setError(null);
    try {
      const res = await fetch(`${AGENT_URL}/start`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to start agent.");
        setLaunching(false);
      }
    } catch (err) {
      setError(`Can't reach the agent server at ${AGENT_URL}. Is it running? (node index.js --serve)`);
      setLaunching(false);
    }
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Agent Dashboard</h1>
          <p className="mt-1 text-sm text-provo-muted">
            Watch the autonomous buyer agent shop for GPU compute on-chain in real time.
          </p>
        </div>
        <button
          type="button"
          onClick={handleLaunch}
          disabled={agentRunning || launching || !connected}
          className="rounded-xl bg-provo-pass px-6 py-3 text-sm font-bold text-provo-bg transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {launching ? "Launching…" : agentRunning ? "Agent Running" : "🚀 Launch Agent"}
        </button>
      </div>

      {/* Status bar */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="rounded-xl border border-provo-border bg-provo-surface p-4">
          <div className="text-xs text-provo-muted mb-1">Connection</div>
          <div className={`text-sm font-semibold ${connected ? "text-provo-pass" : "text-provo-fail"}`}>
            <span className={`inline-block h-2 w-2 rounded-full mr-2 ${connected ? "bg-provo-pass" : "bg-provo-fail"}`} />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>
        <div className="rounded-xl border border-provo-border bg-provo-surface p-4">
          <div className="text-xs text-provo-muted mb-1">Status</div>
          <div className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold border ${STATUS_COLORS[latestStatus] || STATUS_COLORS.idle}`}>
            {STATUS_LABELS[latestStatus] || latestStatus}
          </div>
        </div>
        <div className="rounded-xl border border-provo-border bg-provo-surface p-4">
          <div className="text-xs text-provo-muted mb-1">Attempt</div>
          <div className="text-sm font-semibold text-provo-text">
            {attemptInfo.current > 0 ? `${attemptInfo.current}/${attemptInfo.max}` : "—"}
          </div>
        </div>
        <div className="rounded-xl border border-provo-border bg-provo-surface p-4">
          <SpendBar spent={spentDisplay} cap={capDisplay} />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-provo-fail/40 bg-provo-fail/10 px-4 py-3 text-sm text-provo-fail">
          {error}
        </div>
      )}

      {/* Event feed */}
      <div
        ref={feedRef}
        className="space-y-3 max-h-[60vh] overflow-y-auto pr-2 scroll-smooth"
      >
        {events.length === 0 && !agentRunning && (
          <div className="rounded-xl border border-dashed border-provo-border bg-provo-surface/30 p-12 text-center">
            <p className="text-lg text-provo-muted">
              {connected
                ? "Click \"Launch Agent\" to start the autonomous buyer flow."
                : "Start the agent server first:"}
            </p>
            {!connected && (
              <pre className="mt-3 inline-block rounded-lg bg-provo-bg px-4 py-2 text-left text-xs text-provo-text">
                cd buyer-agent{"\n"}node index.js --serve --min-tok-s 90 --max-spend 0.05
              </pre>
            )}
          </div>
        )}
        {events.map((event, i) => (
          <EventCard key={`${event.timestamp}-${i}`} event={event} />
        ))}
      </div>
    </div>
  );
}
