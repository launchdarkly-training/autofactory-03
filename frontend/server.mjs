/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * LaunchDarkly is optional: if the SDK or LD_SDK_KEY is absent, flags resolve to
 * "control" and the page renders its existing behavior.
 */

import express from "express";
import { pathToFileURL } from "node:url";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";
const SDK_KEY = process.env.LD_SDK_KEY;

const FLAG_BACKEND_STATUS = "enable-backend-status";
const LD_CONTEXT = { kind: "user", key: "demo-user" };

let ldClientPromise = null;

/** Lazily initialize the LaunchDarkly client (or resolve to null if unavailable). */
function ldClient() {
  if (!SDK_KEY) return Promise.resolve(null);
  if (!ldClientPromise) {
    ldClientPromise = (async () => {
      try {
        const ld = await import("@launchdarkly/node-server-sdk");
        const client = ld.init(SDK_KEY);
        await client.waitForInitialization({ timeout: 5 });
        return client;
      } catch {
        // demo: degrade gracefully without LD
        return null;
      }
    })();
  }
  return ldClientPromise;
}

/**
 * Evaluate a string multivariate flag. Fails safe to "control", so an
 * unreachable LaunchDarkly or a missing flag always takes the existing path.
 */
export async function flagVariation(key, defaultValue = "control") {
  const client = await ldClient();
  if (!client) return defaultValue;
  try {
    const value = await client.variation(key, LD_CONTEXT, defaultValue);
    return typeof value === "string" ? value : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Emit the guarded-release events for the backend status panel. Event keys are
 * written out literally so they stay greppable and match the LaunchDarkly
 * metrics. Telemetry failures are swallowed — they must never fail a request.
 */
export async function trackBackendStatus({ ok, durationMs }) {
  try {
    const client = await ldClient();
    if (!client) return;
    if (ok) {
      client.track("enable-backend-status-success", LD_CONTEXT);
    } else {
      client.track("enable-backend-status-error", LD_CONTEXT);
    }
    if (Number.isFinite(durationMs)) {
      client.track("enable-backend-status-latency", LD_CONTEXT, undefined, durationMs);
    }
  } catch {
    // telemetry is best-effort
  }
}

export function renderPage({ showBackendStatus }) {
  const backendStatusMarkup = showBackendStatus
    ? `
  <p id="backend-status">Checking backend status…</p>`
    : "";
  const backendStatusScript = showBackendStatus
    ? `
    const backendStatusStart = Date.now();
    const reportBackendStatus = (ok) => {
      try {
        fetch("/api/backend-status-report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          keepalive: true,
          body: JSON.stringify({ ok, ms: Date.now() - backendStatusStart }),
        }).catch(() => {});
      } catch (e) {}
    };
    fetch("${BACKEND_URL}/api/status")
      .then(r => r.json())
      .then(d => { document.getElementById("backend-status").textContent =
        "Backend online: " + d.service + " version " + d.version; reportBackendStatus(true); })
      .catch(() => { document.getElementById("backend-status").textContent = "Backend offline"; reportBackendStatus(false); });`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>${backendStatusMarkup}
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });${backendStatusScript}
  </script>
</body></html>`;
}

export function createApp({
  resolveVariation = flagVariation,
  track = trackBackendStatus,
} = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.post("/api/backend-status-report", express.json(), (req, res) => {
    const { ok, ms } = req.body || {};
    track({ ok: ok === true, durationMs: Number(ms) });
    res.status(204).end();
  });

  app.get("/", async (_req, res) => {
    const variation = await resolveVariation(FLAG_BACKEND_STATUS, "control");
    res.type("html").send(renderPage({ showBackendStatus: variation === "v1" }));
  });

  return app;
}

const app = createApp();

const port = process.env.PORT || 3000;
const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  app.listen(port, () => console.log(`demo-frontend on :${port}`));
}

export { app, FLAG_BACKEND_STATUS };
