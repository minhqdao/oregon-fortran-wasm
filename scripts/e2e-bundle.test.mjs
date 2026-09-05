// End-to-end boot test for the deploy bundle: verifies the whole chain
// index.html boot guard -> bundled launcher.js -> bundled runner.worker.js ->
// oregon.js glue -> oregon.wasm in a booted game. The dev-server +
// headless-Chrome + CDP plumbing is shared with the other Chrome tests, see
// scripts/chrome-e2e.mjs.
//
// Usage:
//   scripts/bundle-web.sh --out dist
//   node --test scripts/e2e-bundle.test.mjs [port]  (default 8902, dist/ served)

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findChrome, startChromeE2E } from "./chrome-e2e.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2]) || 8902;

const CHROME = findChrome();
const skipReason = CHROME
  ? existsSync(join(repoRoot, "dist", "index.html"))
    ? false
    : "dist/ not built (run scripts/bundle-web.sh --out dist first)"
  : "no Chrome found (set $CHROME; CI covers the chain with the wasm smoke and bundle integrity tests instead)";

test(
  "bundled game boots and reaches first output",
  { skip: skipReason, timeout: 120_000 },
  async () => {
    // Scratch profile + derived port so CDP is isolated from any running
    // Chrome instance and from concurrent runs. The old headless mode is
    // deliberate: it is what this test has always booted against.
    const e2e = await startChromeE2E({
      chrome: CHROME,
      port,
      serve: "dist",
      debugPort: 9337 + (process.pid % 100),
      profilePrefix: "oregon-fortran-e2e-profile",
      headlessFlag: "--headless",
    });
    try {
      await e2e.send("Page.navigate", { url: `http://localhost:${port}/` });

      // Poll for the game's first output (or a boot error). A boot with any
      // guarded reload swaps the execution context mid-poll, so a failed or
      // empty evaluate means "keep waiting", not failure.
      let state = null;
      for (let i = 0; i < 90 && !state; i++) {
        await new Promise((r) => setTimeout(r, 500));
        let value;
        try {
          value = await e2e.evaluate(
            "JSON.stringify({output: document.getElementById('output').textContent, status: document.getElementById('status').textContent})",
          );
        } catch {
          continue;
        }
        if (!value) continue;
        const parsed = JSON.parse(value);
        if (/DO YOU NEED INSTRUCTIONS/.test(parsed.output) || parsed.status) {
          state = parsed;
        }
      }
      assert.ok(state, "game did not boot within 45s");
      assert.match(
        state.output,
        /DO YOU NEED INSTRUCTIONS/,
        "bundled game reaches first output",
      );
      assert.equal(state.status, "", "no boot errors on a healthy bundle");
    } finally {
      e2e.close();
    }
  },
);
