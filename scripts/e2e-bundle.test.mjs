// End-to-end boot test for the deploy bundle: serves dist/ from the COOP/COEP
// dev-server for the duration of the test and drives headless Chrome over CDP
// (real timers, no --virtual-time-budget, which fast-forwards timers past the
// real async worker startup and would trip the launcher's 15 s startup
// watchdog artificially). Verifies the whole chain: index.html boot guard ->
// bundled launcher.js -> bundled runner.worker.js -> oregon.js glue ->
// oregon.wasm.
//
// Chrome is located via $CHROME, well-known macOS app paths, and the usual
// google-chrome/chromium names on PATH. The test skips with an explicit
// reason when Chrome or a built dist/ is missing.
//
// Usage:
//   scripts/bundle-web.sh --out dist
//   node --test scripts/e2e-bundle.test.mjs [port]  (default 8902, dist/ served)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2]) || 8902;

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findChrome() {
  if (process.env.CHROME) {
    return isExecutable(process.env.CHROME) ? process.env.CHROME : null;
  }
  const appPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const path of appPaths) {
    if (isExecutable(path)) return path;
  }
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (isExecutable(path)) return path;
    }
  }
  return null;
}

const CHROME = findChrome();
const skipReason = CHROME
  ? existsSync(join(repoRoot, "dist", "index.html"))
    ? false
    : "dist/ not built (run scripts/bundle-web.sh --out dist first)"
  : "no Chrome found (set $CHROME; CI covers the chain with the wasm smoke and bundle integrity tests instead)";

/** @param {() => Promise<boolean>} predicate */
async function waitUntil(predicate, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

test(
  "bundled game boots and reaches first output",
  { skip: skipReason, timeout: 120_000 },
  async () => {
    // Scratch profile + derived ports so CDP is reachable and isolated from
    // any running Chrome instance and from concurrent runs.
    const debugPort = 9337 + (process.pid % 100);
    const profileDir = join(
      process.env.TMPDIR || "/tmp",
      `colossal-cave-e2e-profile-${process.pid}`,
    );
    const server = spawn(
      process.execPath,
      ["scripts/dev-server.mjs", String(port), "dist"],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] },
    );
    let serverError = "";
    server.stderr.on("data", (chunk) => {
      serverError += String(chunk);
    });
    const browser = spawn(
      CHROME,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDir}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );

    try {
      assert.ok(
        await waitUntil(async () => {
          try {
            return (await fetch(`http://localhost:${port}/`)).ok;
          } catch {
            return server.exitCode === null;
          }
        }, 50, 100),
        `dist dev server came up on port ${port}${serverError ? `: ${serverError}` : ""}`,
      );

      // Wait for the DevTools endpoint.
      let wsUrl = null;
      const endpointUp = await waitUntil(async () => {
        try {
          const targets = await (
            await fetch(`http://localhost:${debugPort}/json/list`)
          ).json();
          const page = targets.find((t) => t.type === "page");
          if (page) {
            wsUrl = page.webSocketDebuggerUrl;
            return true;
          }
        } catch {
          // Chrome not ready yet.
        }
        return false;
      }, 150, 100);
      assert.ok(endpointUp, "Chrome DevTools endpoint came up");

      const state = await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let nextId = 0;
        const pending = new Map();
        const send = (method, params) =>
          new Promise((res) => {
            const id = ++nextId;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method, params }));
          });
        const timer = setTimeout(
          () => reject(new Error("CDP evaluation timed out")),
          45_000,
        );
        ws.addEventListener("message", (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg.result);
            pending.delete(msg.id);
          }
        });
        ws.addEventListener("open", async () => {
          await send("Page.navigate", { url: `http://localhost:${port}/` });
          // Poll for the game's first output (or a boot error). A boot with
          // any guarded reload swaps the execution context mid-poll, so an
          // empty evaluate result means "keep waiting", not failure.
          for (let i = 0; i < 90; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const result = await send("Runtime.evaluate", {
              expression:
                "JSON.stringify({output: document.getElementById('output').textContent, status: document.getElementById('status').textContent})",
              returnByValue: true,
            });
            if (!result?.result?.value) continue;
            const state = JSON.parse(result.result.value);
            if (/DO YOU NEED INSTRUCTIONS/.test(state.output) || state.status) {
              clearTimeout(timer);
              resolve(state);
              return;
            }
          }
          clearTimeout(timer);
          reject(new Error("game did not boot within 45s"));
        });
        ws.addEventListener("error", () =>
          reject(new Error("CDP WebSocket failed")),
        );
      });

      assert.match(
        state.output,
        /DO YOU NEED INSTRUCTIONS/,
        "bundled game reaches first output",
      );
      assert.equal(state.status, "", "no boot errors on a healthy bundle");
    } finally {
      browser.kill();
      server.kill();
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // Chrome can still hold the scratch profile momentarily; the pid
        // keeps the next run from colliding with the leftovers.
      }
    }
  },
);
