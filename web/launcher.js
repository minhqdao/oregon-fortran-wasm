// @ts-check
//
// Adapted from Basicade's launcher for a single compiled WASM game: there is
// no game catalog and no fetched BASIC source, only the Fortran module to
// start in the runner worker.

import {
  sanitizeTerminalOutput,
  stripLineLeadingSpace,
} from "./terminal-output.js";
import { isTouchPointer, moveInputCaretToEnd } from "./terminal-input.js";
import {
  scrollTerminalToBottom,
} from "./terminal-scroll.js";
import { hasTextSelection, updateTextContent } from "./terminal-selection.js";
import {
  createKeysBuffer,
  maxInputLength,
  runnerCommand,
  runnerEvent,
  writeInputLine,
} from "./runner-protocol.js";
import { createFrameBatcher } from "./terminal-render.js";

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

const wasmUrl = new URL("./oregon.js", import.meta.url).href;

let terminalText = "LOADING...\n";
let currentInput = "";
let waitingForInput = false;
let pendingInputSeparator = false;
let hasReceivedFirstOutput = false;
let isCursorActive = false;
/** @type {Worker | undefined} */
let worker;
/** @type {number | undefined} */
let workerStartupTimer;
let runId = 0;
let lastWorkerMessageAt = 0;
/** @type {number | undefined} */
let inputResponseTimer;
const maxStartupRetries = 1;
const workerStartupTimeoutMs = 15_000;
// The game answers a submitted line within a few milliseconds; the worker is
// also the only thing that can ever clear the "waiting for input" state, so
// a silent gap after submitting means iOS suspended the process mid-flight.
const inputResponseTimeoutMs = 2_500;

/** @param {string} text */
function appendOutput(text) {
  if (!hasReceivedFirstOutput) {
    terminalText = "";
    hasReceivedFirstOutput = true;
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
  }

  // Visually separate user input from the game's answer with a blank line.
  // Output that already starts with one (a leading "/" in the FORTRAN
  // format, e.g. the MONDAY turn header) provides the separator itself.
  if (pendingInputSeparator && !text.startsWith("\n")) {
    terminalText += "\n";
  }
  pendingInputSeparator = false;

  const atLineStart = terminalText === "" || terminalText.endsWith("\n");
  terminalText += stripLineLeadingSpace(
    sanitizeTerminalOutput(text),
    atLineStart,
  );
  scheduleOutputRender();
}

function scheduleOutputRender() {
  // The game can emit a block as a burst of individual lines. Rendering and
  // scrolling for every worker message makes the bottom of the terminal
  // visibly jump between intermediate layouts. Paint the complete burst once.
  outputRenderer.schedule();
}

const outputRenderer = createFrameBatcher(() => {
  render();
  scrollTerminalToBottom(screen);
});

function flushOutputRender() {
  outputRenderer.flush();
}

function cancelOutputRender() {
  outputRenderer.cancel();
}

// The soft keyboard is only detected, never laid out against: the terminal
// keeps its normal size and the page scrolls natively. Detecting remains
// necessary because iOS raises the keyboard only for focus() calls made
// inside a gesture handler, so the auto-focus issued when the game asks for
// input leaves the field focused with the keyboard still closed. A tap must
// then re-trigger focus, which requires knowing whether the keyboard is
// already open.
/**
 * The visual viewport when available, otherwise window. Only `height` is
 * read, with a ?? fallback to innerHeight on window.
 * @type {{
 *   height?: number,
 *   addEventListener: typeof window.addEventListener,
 * }}
 */
const keyboardViewport = window.visualViewport ?? window;
const usesMobilePointer = window.matchMedia("(pointer: coarse)");
let keyboardClosedViewportHeight =
  keyboardViewport.height ?? window.innerHeight;

function usesTouchInput() {
  return usesMobilePointer.matches || navigator.maxTouchPoints > 0;
}

function needsSoftKeyboardFocus() {
  if (!usesTouchInput()) return false;
  const height = keyboardViewport.height ?? window.innerHeight;
  const closedHeight = Math.max(
    keyboardClosedViewportHeight,
    window.innerHeight,
    height,
  );
  return closedHeight - height <= 80;
}

document.addEventListener(
  "visibilitychange",
  restoreTerminalAfterVisibilityChange,
);

// Desktop-only safety net. The keyboard-constraining code was removed in
// favor of native page scrolling on touch, but on a desktop a window resize
// (OS resize, fullscreen toggle, devtools dock) re-measures the scrollable
// terminal without firing anything that keeps the just-shown prompt in view,
// so it can end up scrolled off. Touch is deliberately excluded: the visual
// viewport drives its own scrolling there and yanking the terminal to the
// bottom during the soft-keyboard animation is exactly the behavior the
// rework removed.
window.addEventListener("resize", () => {
  if (usesTouchInput()) return;
  if (!waitingForInput || document.activeElement !== terminalInput) return;
  scrollTerminalToBottom(screen);
});

terminalInput.addEventListener("focus", () => {
  render();
  // At focus time the keyboard is (nearly) always still closed, so this is
  // the reliable moment to record the unobstructed viewport height.
  keyboardClosedViewportHeight = Math.max(
    keyboardClosedViewportHeight,
    keyboardViewport.height ?? window.innerHeight,
  );
});
terminalInput.addEventListener("blur", () => {
  // Clicking terminal text briefly transfers focus so the browser can retain
  // native text selection. Keep the existing cursor animation running until
  // the click determines whether this was a tap/click or a selection drag.
  if (!terminalPointerInteraction) render();
});

function render() {
  updateTextContent(output, terminalText);
  updateTextContent(input, waitingForInput ? currentInput : "");

  updateTextContent(cursor, waitingForInput ? "_" : "");

  const shouldShowCursor =
    waitingForInput && document.activeElement === terminalInput;

  if (shouldShowCursor) {
    if (!isCursorActive) {
      // Transitioning from inactive to active: restart animation
      isCursorActive = true;
      cursor.style.visibility = "visible";
      cursor.classList.remove("blinking");
      void cursor.offsetWidth; // Force reflow to restart CSS animation
      cursor.classList.add("blinking");
    } else {
      // Already active, just ensure it's visible
      cursor.style.visibility = "visible";
    }
  } else {
    // Inactive or not waiting for input
    isCursorActive = false;
    cursor.style.visibility = "hidden";
  }
}

/** @param {string} message */
function setStatus(message) {
  status.textContent = message;
  status.hidden = !message;
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

function submitInput() {
  // Safety net for a worker that vanished without a pagehide/pageshow cycle
  // (iOS reclaiming a suspended tab): the submit would otherwise vanish into
  // dead shared memory. The watchdog below covers the slower variant where
  // the worker dies after the line was queued.
  if (!worker || !sharedBuffer || !sharedKeys) {
    restartGame();
    return;
  }

  const value = `${currentInput}\n`;
  terminalText += value;
  pendingInputSeparator = true;
  currentInput = "";
  terminalInput.value = "";
  waitingForInput = false;
  render();
  scrollTerminalToBottom(screen);

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

function focusTerminalInput({ force = false } = {}) {
  if (!waitingForInput) return;
  if (document.activeElement === terminalInput) {
    // iOS can leave the field focused without ever showing the soft
    // keyboard. Re-focusing it then does nothing, so on a tap (a real
    // gesture) blur first: the following focus() is an activation again
    // and iOS opens the keyboard.
    if (!force || !needsSoftKeyboardFocus()) return;
    terminalInput.blur();
  }
  // preventScroll: focusing must never yank the viewport around; opening the
  // keyboard itself may, which is Safari's own behavior and left alone.
  terminalInput.focus({ preventScroll: true });
  moveInputCaretToEnd(terminalInput);
}

function restoreTerminalAfterVisibilityChange() {
  if (document.visibilityState !== "visible") return;

  const scrollTop = screen.scrollTop;
  const maxScrollTop = screen.scrollHeight - screen.clientHeight;
  if (maxScrollTop > 0) {
    screen.scrollTop = scrollTop > 0 ? scrollTop - 1 : 1;
    screen.scrollTop = scrollTop;
  }
  // iOS drops the keyboard while the tab is hidden and the field usually
  // stays focused, so a plain focus() would change nothing. The tap on
  // return re-focuses via click; this only refreshes the caret state.
  focusTerminalInput();
}

let terminalPointerInteraction = false;

function handleTerminalClick() {
  // A click is also fired after dragging to select text. Refocusing the hidden
  // input here would collapse the range the user just created.
  const followsTouch = clickFollowsTouch;
  clickFollowsTouch = false;
  if (!hasTextSelection(window.getSelection())) {
    // On touch devices the keyboard only rises for focus() calls inside a
    // gesture handler, and `click` is one that browsers suppress whenever the
    // finger moved (scroll drag, selection pan) -- unlike `pointerdown`,
    // which fires for every touch.
    focusTerminalInput({ force: followsTouch });
  } else {
    render();
  }
  terminalPointerInteraction = false;
}

let touchMouseEventPending = false;
let clickFollowsTouch = false;

/** @param {PointerEvent} event */
function handleTerminalPointerDown(event) {
  terminalPointerInteraction = true;
  touchMouseEventPending = isTouchPointer(event);
  if (touchMouseEventPending) clickFollowsTouch = true;
}

function handleTerminalPointerCancel() {
  terminalPointerInteraction = false;
  render();
}

/** @param {MouseEvent} event */
function handleTerminalMouseDown(event) {
  const followsTouch = touchMouseEventPending;
  touchMouseEventPending = false;
  const targetsTerminalBackground =
    event.target === screen || event.target === terminalContainer;

  // Mobile browsers synthesize mouse events after a touch, while desktop
  // browsers move focus when the blank terminal background is clicked. Avoid
  // both redundant blur/refocus cycles. Mouse selection still works because
  // mousedown events that target terminal text keep their default behavior.
  if (
    document.activeElement === terminalInput &&
    (followsTouch || targetsTerminalBackground)
  ) {
    event.preventDefault();
  }
}

// 1. Handle live typing, backspacing, and mobile "Return/Go" keys
terminalInput.addEventListener("input", (event) => {
  if (!waitingForInput) return;

  // Mobile keyboards often insert a newline (\n) or trigger insertLineBreak instead of an 'Enter' keydown event
  if (
    /** @type {InputEvent} */ (event).inputType === "insertLineBreak" ||
    terminalInput.value.includes("\n")
  ) {
    terminalInput.value = terminalInput.value.replace(/\n/g, "");
    submitInput();
    return;
  }

  // The input buffer stores one byte per character; drop anything outside
  // printable ASCII (IME/CJK/pasted Unicode would otherwise wrap into wrong
  // codes). Keeps the native value, display and submitted text consistent.
  const printable = terminalInput.value.replace(/[^\x20-\x7E]/g, "");
  if (printable !== terminalInput.value) terminalInput.value = printable;

  // Enforce max length on the input field
  if (terminalInput.value.length > maxInputLength) {
    terminalInput.value = terminalInput.value.slice(0, maxInputLength);
  }

  // Convert to upper case for display only; never rewrite the native value here.
  currentInput = terminalInput.value.toUpperCase();
  moveInputCaretToEnd(terminalInput);
  render();
  scrollTerminalToBottom(screen);
});

// 2. Handle desktop 'Enter' key press
terminalInput.addEventListener("keydown", (event) => {
  if (waitingForInput && event.key === "Enter") {
    event.preventDefault();
    submitInput();
  }
});

terminalContainer.addEventListener("pointerdown", handleTerminalPointerDown);
terminalContainer.addEventListener(
  "pointercancel",
  handleTerminalPointerCancel,
);
terminalContainer.addEventListener("mousedown", handleTerminalMouseDown);
terminalContainer.addEventListener("click", handleTerminalClick);

/** @type {Int32Array | undefined} */
let sharedBuffer;
/** @type {Uint8Array | undefined} */
let sharedKeys;
const isolationReloadKey = "oregon-isolation-reload";

// The coi service worker performs its own reloads: the first-visit reload
// once it controls the page, and a degrade reload when COEP credentialless
// fails. This helper covers only the gap coi leaves on a fresh first
// visit (worker registered but not yet controlling the page) with one
// guarded reload; both systems guard with sessionStorage, so the page
// reloads at most once per system per session -- never in a loop.
async function ensureCrossOriginIsolation() {
  if (window.crossOriginIsolated) {
    sessionStorage.removeItem(isolationReloadKey);
    return true;
  }

  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error(
      "This browser does not support SharedArrayBuffer, which the game needs to handle input.",
    );
  }

  if (!navigator.serviceWorker) return false;

  // serviceWorker.ready stays pending forever when no registration can
  // exist (e.g. Safari private browsing rejects them), which would hang
  // the launcher on LOADING...; fail fast instead.
  const ready = await Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!ready) return false;

  if (navigator.serviceWorker.controller) {
    // coi is serving this page and handles its own degradation. Give its
    // in-flight reload a moment to navigate before declaring failure.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (window.crossOriginIsolated) {
      sessionStorage.removeItem(isolationReloadKey);
      return true;
    }
    return false;
  }

  // Registered but not controlling yet: reload once so coi's fetch
  // handler can add the isolation headers to the page itself.
  if (!sessionStorage.getItem(isolationReloadKey)) {
    sessionStorage.setItem(isolationReloadKey, "1");
    window.location.reload();
    return undefined;
  }

  return false;
}

async function start() {
  const currentRunId = ++runId;
  const isIsolated = await ensureCrossOriginIsolation();
  if (currentRunId !== runId) return;
  if (isIsolated === undefined) return;
  if (!isIsolated) {
    throw new Error(
      "The game could not start: cross-origin isolation is unavailable " +
        "(this happens in private browsing or when service workers are " +
        "blocked). Try a regular tab, or reload the page.",
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
function launchWorker(buffer, keys, currentRunId, attempt = 0) {
  if (currentRunId !== runId) return;

  /** @type {Worker | undefined} */
  let createdWorker;
  try {
    createdWorker = new Worker(new URL("./runner.worker.js", import.meta.url), {
      type: "module",
    });
  } catch (error) {
    if (attempt < maxStartupRetries) {
      launchWorker(buffer, keys, currentRunId, attempt + 1);
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
    if (!hasStarted && attempt < maxStartupRetries) {
      launchWorker(buffer, keys, currentRunId, attempt + 1);
      return;
    }

    setStatus(message);
    waitingForInput = false;
    render();
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
      appendOutput(data.text);
    } else if (data.type === "REQUEST_INPUT") {
      currentInput = "";
      terminalInput.value = "";
      waitingForInput = true;
      flushOutputRender();
      focusTerminalInput(); // Focus the command field; a tap opens the keyboard on mobile
    } else if (data.type === "ERROR") {
      if (!hasStarted) {
        handleStartupFailure(data.message);
        return;
      }
      setStatus(data.message);
      waitingForInput = false;
      render();
      releaseWorker();
    } else if (data.type === "EXIT") {
      appendOutput("\n*** SYSTEM OFFLINE ***\n");
      waitingForInput = false;
      flushOutputRender();
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
    return { worker, waitingForInput, runId };
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
  cancelOutputRender();
  setStatus(error.message);
  terminalText = "";
  hasReceivedFirstOutput = false;
  pendingInputSeparator = false;
  render();
}

function restartGame() {
  runId += 1;
  interruptedByPageHide = false;
  releaseWorker();
  cancelOutputRender();
  terminalText = "LOADING...\n";
  hasReceivedFirstOutput = false;
  currentInput = "";
  waitingForInput = false;
  pendingInputSeparator = false;
  setStatus("");
  render();
  screen.scrollTop = 0;
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
