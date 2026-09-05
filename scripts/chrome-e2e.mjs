// Shared harness for the headless-Chrome end-to-end tests
// (scripts/e2e-bundle.test.mjs, scripts/mobile-layout.test.mjs): locates
// Chrome, serves a directory with the COOP/COEP dev server for the duration
// of the test, and connects to a private headless Chrome over the DevTools
// protocol with a minimal CDP client.
//
// Chrome is located via $CHROME, well-known macOS app paths, and the usual
// google-chrome/chromium names on PATH. Callers run findChrome() first and
// skip with an explicit reason when it is missing.
//
// Chrome's very first launch on a fresh ephemeral runner can intermittently
// fail to come up inside the wait window (a pre-existing CI flake: the
// "Chrome DevTools endpoint did not come up" failures predated any UI work).
// startChromeE2E therefore restarts the browser on a FRESH debug port and a
// FRESH scratch profile up to `retries` extra times instead of failing the
// whole test on one bad launch. Nothing survives an attempt -- both
// processes are torn down and respawned, so a half-started Chrome holding
// its derived port cannot poison the retry (the retry gets an OS-assigned
// free port, sidestepping TIME_WAIT / half-open sockets entirely).

import { accessSync, constants, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findChrome() {
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

/** Sleeps before each attempt, so the first probe runs after a tick. */
export async function waitUntil(predicate, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (await predicate()) return true;
  }
  return false;
}

/** Reserves a free TCP port on loopback, then releases it for the caller. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts the dev server (`serve` dir on `port`) and a headless Chrome with a
 * scratch profile, and waits until a CDP page target answers. Resolves to
 * { send, evaluate, close }; close() tears the processes and the profile
 * down and is safe to call from a finally block. Throws (after cleanup) if
 * an endpoint never comes up, including `retries` restarts of the browser
 * (each on a fresh debug port and scratch profile).
 *
 * Real timers only: no --virtual-time-budget, which fast-forwards timers
 * past the real async worker startup and trips the launcher's startup
 * watchdog artificially.
 */
export async function startChromeE2E({
  chrome,
  port,
  serve,
  debugPort,
  profilePrefix,
  headlessFlag = "--headless=new",
  retries = 2,
}) {
  const attempts = retries + 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    // The retry profile gets a fresh suffix; the scratch dir per attempt
    // keeps one abortive launch from affecting the next (Chrome can hold a
    // profile for a moment after a kill).
    const profileDir = join(
      process.env.TMPDIR || "/tmp",
      `${profilePrefix}-${process.pid}-${attempt}`,
    );
    // The first attempt uses the caller's port (so the tests' pid-derived
    // addresses stay predictable); retries take an OS-assigned free port,
    // so leftover half-open sockets from the failed attempt are irrelevant.
    const attemptPort = attempt === 0 ? debugPort : await freePort();

    const server = spawn(
      process.execPath,
      ["scripts/dev-server.mjs", String(port), serve],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] },
    );
    let serverError = "";
    server.stderr.on("data", (chunk) => {
      serverError += String(chunk);
    });
    const browser = spawn(
      chrome,
      [
        headlessFlag,
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        `--remote-debugging-port=${attemptPort}`,
        `--user-data-dir=${profileDir}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );

    // Chrome can still hold the scratch profile momentarily; the pid keeps
    // the next run from colliding with the leftovers.
    const close = () => {
      browser.kill();
      server.kill();
      try {
        rmSync(profileDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      } catch {}
    };

    const serverUp = await waitUntil(async () => {
      try {
        return (await fetch(`http://localhost:${port}/`)).ok;
      } catch {
        // Still waiting unless the server process has actually exited.
        return server.exitCode !== null;
      }
    }, 50, 100);
    if (!serverUp) {
      lastError = new Error(
        `dev server did not come up on port ${port}${serverError ? `: ${serverError}` : ""} (attempt ${attempt + 1}/${attempts})`,
      );
      close();
      continue;
    }

    let wsUrl = null;
    const endpointUp = await (async () => {
      for (let i = 0; i < 150; i++) {
        // A browser that already exited can never answer; give up at once
        // instead of burning the whole wait window.
        if (browser.exitCode !== null) return false;
        try {
          const targets = await (
            await fetch(`http://localhost:${attemptPort}/json/list`)
          ).json();
          const page = targets.find((t) => t.type === "page");
          if (page) {
            wsUrl = page.webSocketDebuggerUrl;
            return true;
          }
        } catch {
          // Chrome not ready yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })();
    if (!endpointUp) {
      const died =
        browser.exitCode !== null
          ? ` (chrome exited with code ${browser.exitCode})`
          : "";
      lastError = new Error(
        `Chrome DevTools endpoint did not come up on port ${attemptPort}${died} (attempt ${attempt + 1}/${attempts})`,
      );
      close();
      continue;
    }

    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = (expression) =>
      send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }).then((result) => {
        if (result.exceptionDetails) {
          throw new Error(JSON.stringify(result.exceptionDetails));
        }
        return result.result?.value;
      });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
    });
    try {
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", () =>
          reject(new Error("CDP WebSocket failed")),
        );
      });
    } catch (error) {
      // The endpoint answered but the socket never opened -- not the launch
      // flake this retries for, so fail immediately.
      ws.close();
      close();
      throw new Error(error.message);
    }

    return { send, evaluate, close };
  }

  throw lastError ?? new Error("startChromeE2E failed without a recorded error");
}
