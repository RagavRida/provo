import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Tiny SSE server that lets the frontend watch the autonomous agent's decision
 * log in real time.
 *
 * Endpoints:
 *   GET  /events  → SSE stream of structured agent events
 *   GET  /status  → JSON snapshot of agent state
 *   POST /start   → Triggers agent.run() if not already running
 *
 * Zero external dependencies — just Node's built-in http module.
 */
export function createAgentServer(agent, { port = 3001 } = {}) {
  const subscribers = new Set();
  let runId = null;
  let running = false;
  let runPromise = null;

  /** Broadcast a structured event to all connected SSE clients. */
  function broadcast(type, data) {
    const event = { type, data, timestamp: Date.now(), runId };
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(payload);
      } catch {
        subscribers.delete(res);
      }
    }
  }

  /** Wire the agent's emit method to broadcast + console. */
  agent.broadcast = broadcast;

  const server = createServer(async (req, res) => {
    // CORS — the frontend runs on a different port.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);

    // ---- SSE stream ----
    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "connected", runId, timestamp: Date.now() })}\n\n`);
      subscribers.add(res);
      req.on("close", () => subscribers.delete(res));
      return;
    }

    // ---- Status snapshot ----
    if (url.pathname === "/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          running,
          runId,
          attempt: agent.attempts.length,
          maxAttempts: agent.workload.maxRetries + 1,
          totalSpentWei: agent.totalSpentWei.toString(),
          totalRecoveredWei: agent.totalRecoveredWei.toString(),
          maxTotalSpendWei: agent.maxTotalSpendWei.toString(),
          attempts: agent.attempts.map((a) => ({
            listingId: a.listingId?.toString(),
            jobId: a.jobId?.toString(),
            passed: a.passed,
            cost: a.cost?.toString(),
            measuredTokPerSec: a.measuredTokPerSec?.toString(),
          })),
        })
      );
      return;
    }

    // ---- Start the agent run ----
    if (url.pathname === "/start" && req.method === "POST") {
      if (running) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent is already running.", runId }));
        return;
      }

      runId = randomUUID().slice(0, 8);
      running = true;
      broadcast("run_started", { runId });

      // Fire and forget — the agent runs asynchronously.
      runPromise = agent
        .run()
        .then((report) => {
          broadcast("run_finished", { status: report.status, success: report.success });
          running = false;
        })
        .catch((err) => {
          broadcast("run_error", { message: err.message });
          running = false;
        });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ started: true, runId }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return {
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, () => {
          console.log(`Agent SSE server listening on http://localhost:${port}`);
          console.log(`  GET  /events → SSE stream`);
          console.log(`  GET  /status → JSON snapshot`);
          console.log(`  POST /start  → Launch the agent run`);
          resolve(server);
        });
      }),
    broadcast,
    server,
  };
}
