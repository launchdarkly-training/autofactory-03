/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * LaunchDarkly is optional: if the SDK or LD_SDK_KEY is absent, flags resolve to
 * "control" and the page renders its existing behavior.
 */

import express from "express";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";
const SDK_KEY = process.env.LD_SDK_KEY;
const app = express();

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

export function renderPage({ showBackendStatus }) {
  const backendStatusMarkup = showBackendStatus
    ? `
  <p id="backend-status">Checking backend status…</p>`
    : "";
  const backendStatusScript = showBackendStatus
    ? `
    fetch("${BACKEND_URL}/api/status")
      .then(r => r.json())
      .then(d => { document.getElementById("backend-status").textContent =
        "Backend online: " + d.service + " version " + d.version; })
      .catch(() => { document.getElementById("backend-status").textContent = "Backend offline"; });`
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

app.get("/api/status", (_req, res) => {
  res.json({ service: "demo-frontend", version: SHA });
});

app.get("/", async (_req, res) => {
  const variation = await flagVariation(FLAG_BACKEND_STATUS, "control");
  res.type("html").send(renderPage({ showBackendStatus: variation === "v1" }));
});

const port = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => console.log(`demo-frontend on :${port}`));
}

export { app, FLAG_BACKEND_STATUS };
