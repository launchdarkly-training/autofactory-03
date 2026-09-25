/**
 * Flag-path tests for `enable-backend-status`.
 *
 * The flag is a string multivariate flag, so every case drives the evaluation
 * with the string values ("v1" / "control") rather than booleans.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FLAG_BACKEND_STATUS,
  createApp,
  flagVariation,
  renderPage,
} from "./server.mjs";

/** The page exactly as it rendered before this feature existed. */
const BASELINE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>dev</code></p>
  <p id="greeting">Loading greeting from backend…</p>
  <script>
    fetch("http://localhost:8000/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });
  </script>
</body></html>`;

async function getPage(variation) {
  const app = createApp({ resolveVariation: async () => variation });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 200);
    return await res.text();
  } finally {
    server.close();
  }
}

test("control serves the page exactly as it was before the flag existed", async () => {
  assert.equal(await getPage("control"), BASELINE_PAGE);
});

test("v1 serves the backend status panel", async () => {
  const html = await getPage("v1");
  assert.match(html, /<p id="backend-status">Checking backend status…<\/p>/);
  assert.match(html, /fetch\("http:\/\/localhost:8000\/api\/status"\)/);
  assert.match(html, /"Backend online: " \+ d\.service \+ " version " \+ d\.version/);
  assert.match(html, /"Backend offline"/);
});

test("an unrecognised variation falls back to the control path", async () => {
  assert.equal(await getPage("v2"), BASELINE_PAGE);
  assert.equal(await getPage(""), BASELINE_PAGE);
});

test("flagVariation fails safe to control when LaunchDarkly is unavailable", async () => {
  assert.equal(await flagVariation(FLAG_BACKEND_STATUS, "control"), "control");
});

test("only the v1 page reports guarded-release events", async () => {
  assert.match(renderPage({ showBackendStatus: true }), /\/api\/backend-status-report/);
  assert.doesNotMatch(renderPage({ showBackendStatus: false }), /backend-status-report/);
});

test("the beacon route emits the success and latency events", async () => {
  const events = [];
  const app = createApp({ track: (e) => events.push(e) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/backend-status-report`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, ms: 42 }),
      },
    );
    assert.equal(res.status, 204);
  } finally {
    server.close();
  }
  assert.deepEqual(events, [{ ok: true, durationMs: 42 }]);
});

test("the beacon route reports a failed status fetch as an error", async () => {
  const events = [];
  const app = createApp({ track: (e) => events.push(e) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/api/backend-status-report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, ms: 7 }),
    });
  } finally {
    server.close();
  }
  assert.deepEqual(events, [{ ok: false, durationMs: 7 }]);
});

test("track() uses literal event keys that match the LaunchDarkly metrics", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  for (const eventKey of [
    "enable-backend-status-success",
    "enable-backend-status-error",
    "enable-backend-status-latency",
  ]) {
    assert.ok(
      source.includes(`client.track("${eventKey}"`),
      `expected a literal track("${eventKey}") call`,
    );
  }
});
