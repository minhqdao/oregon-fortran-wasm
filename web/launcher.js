// @ts-check
//
// Adapted from Basicade's launcher for a single compiled WASM game: there is
// no game catalog and no fetched BASIC source, only the Fortran module to
// start in the runner worker.
//
// Everything the user touches -- the transcript, the command line (IMEs
// included), scrolling, the soft keyboard -- lives in the terminal-shell
// npm package. This launcher is the host glue only:
// the worker lifecycle, cross-origin isolation recovery, status text, and
// restart.
//
// The import reaches into node_modules with a relative path (rather than
// a bare specifier plus an import map) so it also resolves inside the
// runner worker, where a document import map does not apply: the dev
// server mounts the installed package at /node_modules/, and esbuild
// inlines it for the deploy bundle.

import {
  createKeysBuffer,
  createTerminalShell,
  maxInputLength,
  runnerCommand,
  runnerEvent,
  writeInputLine,
} from "../node_modules/terminal-shell/src/index.js";

const output = /** @type {HTMLElement} */ (document.getElementById("output"));
const input = /** @type {HTMLElement} */ (document.getElementById("input"));
const cursor = /** @type {HTMLElement} */ (document.getElementById("cursor"));
const screen = /** @type {HTMLElement} */ (document.getElementById("screen"));
const terminalContainer = /** @type {HTMLElement} */ (document.getElementById("terminal-container"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const restartButton = /** @type {HTMLButtonElement} */ (document.getElementById("restart-game"));
const terminalInput = /** @type {HTMLInputElement} */ (
  document.getElementById("terminal-input")
);
const main = /** @type {HTMLElement | null} */ (document.querySelector("main"));

const wasmUrl = new URL("./oregon.js", import.meta.url).href;

// --- the terminal shell -------------------------------------------------------
//
// The hidden field owns the text; the shell reads it, echoes it, and
// normalizes the submitted line to printable ASCII exactly once (its
// toEngineText policy) before onLine hands it to the engine buffer. The
// inset target carries --keyboard-inset for the soft-keyboard driver, and
// the native-log dataset switches Android to its own transcript scroller.

const shell = createTerminalShell({
  screen,
  output,
  inputLine: input,
  cursor,
  field: terminalInput,
  container: terminalContainer,
  insetTarget: main,
  nativeLogDataset: "oregonLog",
  maxInputLength,
  onLine: handleLine,
  onFirstOutput() {
    // The first game output means the whole module graph loaded and the
    // worker is streaming: disarm index.html's boot guard (recovery reload
    // + watchdog) so it can never misfire later in the session.
    document.documentElement.dataset.oregonBootDone = "1";
    try {
      sessionStorage.removeItem("oregon-module-reload");
    } catch {
      // Private modes can throw on storage access; the guard is
      // session-scoped anyway and loses relevance after boot.
    }
  },
});

/** @param {string} message */
function setStatus(message) {
  status.textContent = message;
  status.hidden = !message;
}

// --- worker lifecycle ----------------------------------------------------------
//
// A healthy boot finishes in ~1-2s (~550KB total: launcher + worker +
// wasm glue + wasm binary), so 8s per attempt is still ~4-8x headroom
// while keeping the worst case bounded: 3 attempts x 8s + 0.6s + 1.2s
// backoff ~= 26s, slightly under the old 2 x 15s = 30s budget despite
// the extra attempt. The 20s boot watchdog may fire during the third
// attempt; the launcher's final status then overwrites it with the
// specific failure.
const workerStartupTimeoutMs = 8_000;
// Transient fetch blips (worker script, wasm glue, wasm binary) are the
// common intermittent boot failure; an immediate retry often re-hits the
// same blip, so retries back off linearly (600ms, then 1200ms) to let the
// network settle. Restart/pagehide bumps runId, which aborts a pending
// retry via the currentRunId check in launchWorker/scheduleStartupRetry.
const startupRetryBaseDelayMs = 600;
// The game answers a submitted line within a few milliseconds; the worker is
// also the only thing that can ever clear the "waiting for input" state, so
// a silent gap after submitting means iOS suspended the process mid-flight.
const inputResponseTimeoutMs = 2_500;
const maxStartupRetries = 2;

/** @type {Worker | undefined} */
let worker;
/** @type {number | undefined} */
let workerStartupTimer;
let runId = 0;
let lastWorkerMessageAt = 0;
/** @type {number | undefined} */
let inputResponseTimer;
/** @type {Int32Array | undefined} */
let sharedBuffer;
/** @type {Uint8Array | undefined} */
let sharedKeys;

/**
 * The engine accepted the line: write it into the shared buffer and arm
 * the response watchdog. (Shell submit -> onLine.)
 * @param {string} value the normalized line including its trailing "\n"
 */
function handleLine(value) {
  // Safety net for a worker that vanished without a pagehide/pageshow cycle
  // (iOS reclaiming a suspended tab): the submit would otherwise vanish into
  // dead shared memory. The watchdog below covers the slower variant where
  // the worker dies after the line was queued.
  if (!worker || !sharedBuffer || !sharedKeys) {
    restartGame();
    return;
  }

  writeInputLine(sharedKeys, value);
  Atomics.store(sharedBuffer, 0, 1);
  Atomics.notify(sharedBuffer, 0, 1);

  // A worker killed while the page was hidden (pagehide terminated it, or iOS
  // reclaimed it) never consumes the line and never reports anything: without
  // this watch the terminal would look frozen with a keyboard open.
  const submittedAt = Date.now();
  clearTimeout(inputResponseTimer);
  inputResponseTimer = setTimeout(() => {
    inputResponseTimer = undefined;
    if (lastWorkerMessageAt < submittedAt) restartGame();
  }, inputResponseTimeoutMs);
}

function releaseWorker() {
  terminalInput.blur();
  clearTimeout(workerStartupTimer);
  workerStartupTimer = undefined;
  clearTimeout(inputResponseTimer);
  inputResponseTimer = undefined;
  if (worker) {
    worker.terminate();
    worker = undefined;
  }
  sharedBuffer = undefined;
  sharedKeys = undefined;
}

// --- cross-origin isolation ----------------------------------------------------

const isolationReloadKey = "oregon-isolation-reload";

// Service-worker isolation can be late rather than impossible -- first
// visits, and private tabs (iOS 17+ supports them, iOS earlier does not)
// claim the page a beat after our check can wait. One guarded reload per
// session is therefore the recovery for EVERY dead end below: if a fresh
// document is isolated, it plays; if it still can't become isolated, the
// guard is spent, the second pass answers false, and the friendly
// message is honest. coi performs its own reloads (first-visit, COEP
// degrade); both systems guard with sessionStorage, so the page reloads
// at most once per system per session -- never in a loop.
/** @returns {boolean | undefined} reloads, or reports the final verdict */
function tryRecoveryReload() {
  if (sessionStorage.getItem(isolationReloadKey)) return false;
  sessionStorage.setItem(isolationReloadKey, "1");
  window.location.reload();
  return undefined;
}
async function ensureCrossOriginIsolation() {
  if (window.crossOriginIsolated) {
    sessionStorage.removeItem(isolationReloadKey);
    return true;
  }

  if (typeof SharedArrayBuffer === "undefined") {
    // An app's built-in browser (Instagram, TikTok, ...) -- on iOS always
    // a WKWebView, which cannot run the game's engine no matter what the
    // page asks for. The only helpful message is the one-action fix.
    const ua = navigator.userAgent;
    const mobile =
      /iP(hone|ad|od)/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ||
      /Android/.test(ua);
    const iosDevice =
      /iP(hone|ad|od)/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    throw new Error(
      mobile
        ? iosDevice
          ? "The game can't run in this app's browser. Tap the ⋯ or share icon and choose “Open in Safari” to play."
          : "The game can't run in this app's browser. Open the ⋮ menu and choose “Open in Chrome” to play."
        : "The game needs a newer browser. Open it in the latest Chrome, Safari, Firefox, or Edge to play.",
    );
  }

  if (!navigator.serviceWorker) return false;

  // serviceWorker.ready stays pending when no registration can exist; if
  // it never lands this waits briefly (private tabs can claim late rather
  // than never) and then gets the one guarded reload, same as the
  // not-yet-controlling case below.
  const ready = await Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!ready) return tryRecoveryReload();

  if (navigator.serviceWorker.controller) {
    // coi is serving this page and handles its own degradation. Give its
    // in-flight reload a moment to navigate before declaring failure.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (window.crossOriginIsolated) {
      sessionStorage.removeItem(isolationReloadKey);
      return true;
    }
    return tryRecoveryReload();
  }

  // Registered but not controlling yet: reload once so coi's fetch
  // handler can add the isolation headers to the page itself.
  return tryRecoveryReload();
}

// --- boot ------------------------------------------------------------------------

async function start() {
  const currentRunId = ++runId;
  const isIsolated = await ensureCrossOriginIsolation();
  if (currentRunId !== runId) return;
  if (isIsolated === undefined) return;
  if (!isIsolated) {
    throw new Error(
      "The game couldn't load. This usually means you're in a " +
        "private tab — reopen the link in a normal tab, or try reloading.",
    );
  }

  const buffer = new SharedArrayBuffer(4);
  const keys = createKeysBuffer();
  sharedBuffer = new Int32Array(buffer);
  sharedKeys = new Uint8Array(keys);
  Atomics.store(sharedBuffer, 0, 0);
  Atomics.store(sharedKeys, 0, 0);

  launchWorker(buffer, keys, currentRunId);
}

/**
 * @param {SharedArrayBuffer} buffer
 * @param {SharedArrayBuffer} keys
 * @param {number} currentRunId
 * @param {number} [attempt]
 */
function scheduleStartupRetry(buffer, keys, currentRunId, attempt) {
  const baseAttempt = attempt ?? 0;
  const nextAttempt = baseAttempt + 1;
  const delayMs = startupRetryBaseDelayMs * nextAttempt;
  setTimeout(() => {
    if (currentRunId !== runId) return;
    launchWorker(buffer, keys, currentRunId, nextAttempt);
  }, delayMs);
}

/**
 * @param {SharedArrayBuffer} buffer
 * @param {SharedArrayBuffer} keys
 * @param {number} currentRunId
 * @param {number} [attempt]
 */
function launchWorker(buffer, keys, currentRunId, attempt = 0) {
  if (currentRunId !== runId) return;
  const currentAttempt = attempt ?? 0;

  /** @type {Worker | undefined} */
  let createdWorker;
  try {
    createdWorker = new Worker(new URL("./runner.worker.js", import.meta.url), {
      type: "module",
    });
  } catch (error) {
    if (currentAttempt < maxStartupRetries) {
      scheduleStartupRetry(buffer, keys, currentRunId, currentAttempt);
      return;
    }
    throw error;
  }
  if (!createdWorker) return;
  const activeWorker = createdWorker;
  worker = activeWorker;
  let hasStarted = false;

  function markGameStarted() {
    hasStarted = true;
    clearTimeout(workerStartupTimer);
    workerStartupTimer = undefined;
  }

  /** @param {string} message */
  function handleStartupFailure(message) {
    if (worker !== activeWorker) return;
    clearTimeout(workerStartupTimer);
    workerStartupTimer = undefined;
    activeWorker.terminate();
    worker = undefined;

    if (currentRunId !== runId) return;
    if (!hasStarted && currentAttempt < maxStartupRetries) {
      scheduleStartupRetry(buffer, keys, currentRunId, currentAttempt);
      return;
    }

    setStatus(message);
    shell.endInput();
    releaseWorker();
  }

  workerStartupTimer = setTimeout(() => {
    handleStartupFailure("The game worker timed out during startup.");
  }, workerStartupTimeoutMs);

  activeWorker.onmessage = (event) => {
    if (worker !== activeWorker) return;
    lastWorkerMessageAt = Date.now();
    const data = runnerEvent(event.data);
    if (data.type === "READY") {
      activeWorker.postMessage(
        runnerCommand({ type: "START", buffer, keys }),
      );
    } else if (data.type === "STARTED") {
      markGameStarted();
    } else if (data.type === "STDOUT") {
      shell.appendOutput(data.text);
    } else if (data.type === "REQUEST_INPUT") {
      shell.beginInput(); // Focus the command field; a tap opens the keyboard on mobile
    } else if (data.type === "ERROR") {
      if (!hasStarted) {
        handleStartupFailure(data.message);
        return;
      }
      setStatus(data.message);
      shell.endInput();
      releaseWorker();
    } else if (data.type === "EXIT") {
      shell.appendOutput("\n*** SYSTEM OFFLINE ***\n");
      shell.endInput();
      shell.flushOutputRender();
      releaseWorker();
    }
  };

  activeWorker.onerror = (event) => {
    event.preventDefault();
    handleStartupFailure(event.message || "The game worker failed.");
  };
  activeWorker.postMessage(
    runnerCommand({ type: "INIT", wasmUrl }),
  );
}

// iOS fires pagehide when a tab is backgrounded, and the worker either dies
// with the suspended process or is terminated here. Any restore path (plain
// foregrounding, bfcache) then resumes into a dead game, so remember that a
// live game was lost and restart on the next pageshow.
let interruptedByPageHide = false;

window.addEventListener("pagehide", () => {
  interruptedByPageHide = Boolean(worker);
  releaseWorker();
});

/**
 * Read-only snapshot for the jsdom smoke tests and debug console use
 * (scripts/browser-smoke.test.mjs); the launcher itself never reads it.
 */
const debugHandle = /** @type {Window & { oregonDebug: { get state(): { worker: Worker | undefined, waitingForInput: boolean, runId: number } } }} */ (
  /** @type {unknown} */ (window)
);
debugHandle.oregonDebug = {
  get state() {
    return { worker, waitingForInput: shell.isWaitingForInput(), runId };
  },
};

window.addEventListener("pageshow", () => {
  if (!interruptedByPageHide) return;
  interruptedByPageHide = false;
  restartGame();
});

/** @param {Error} error */
function reportStartError(error) {
  releaseWorker();
  shell.reset("");
  setStatus(error.message);
}

function restartGame() {
  runId += 1;
  interruptedByPageHide = false;
  releaseWorker();
  shell.reset("LOADING...\n");
  setStatus("");
  startGame();
}

restartButton.addEventListener("click", restartGame);

function startGame() {
  const expectedRunId = runId + 1;
  start().catch((error) => {
    if (expectedRunId === runId) reportStartError(error);
  });
}

startGame();
