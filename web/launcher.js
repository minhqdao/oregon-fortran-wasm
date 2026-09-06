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
  isPinnedToBottom,
  measureKeyboardInset,
  scrollTerminalToBottom,
} from "./terminal-scroll.js";
import {
  decideLogMove,
  decideLogWheel,
  drivenScrollTop,
  flickVelocity,
  momentumStep,
} from "./terminal-log.js";
import {
  KEYBOARD_HEIGHT_KEY,
  KEYBOARD_SLIDE_MS,
  LATE_READING_FRACTION,
  MISMATCH_PX,
  SETTLE_EPSILON_PX,
  decideReading,
  detectKeyboardMode,
  easeInOut,
  forecastInset,
  retargetDuration,
  shouldBlockNorthDrag,
} from "./terminal-keyboard.js";
import { hasTextSelection, updateTextContent } from "./terminal-selection.js";
import { toEngineText } from "./terminal-text.js";
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
const main = /** @type {HTMLElement | null} */ (document.querySelector("main"));

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
const maxStartupRetries = 2;
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

// Soft-keyboard detection (the layout response is the --keyboard-inset
// wiring below) is necessary because iOS raises the keyboard only for
// focus() calls made inside a gesture handler, so the auto-focus issued
// when the game asks for input leaves the field focused with the keyboard
// still closed. A tap must then re-trigger focus, which requires knowing
// whether the keyboard is already open.
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
// Fixed-shell touch layout (mirrors the CSS shell in index.html -- keep in
// step): coarse pointer with no hover, i.e. phones/tablets but not touch
// laptops, which keep the scrolling desktop layout.
const usesFixedShell = window.matchMedia(
  "(pointer: coarse) and (hover: none)",
);
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

// Desktop-only safety net: a window resize (OS resize, fullscreen toggle,
// devtools dock) re-measures the scrollable terminal without firing
// anything that keeps the just-shown prompt in view, so it can end up
// scrolled off. Touch is excluded here -- the keyboard-inset update below
// owns the touch re-scroll -- because yanking the terminal to the bottom
// mid soft-keyboard-animation is exactly what the inset tracks instead.
window.addEventListener("resize", () => {
  if (usesTouchInput()) return;
  if (!waitingForInput || document.activeElement !== terminalInput) return;
  scrollTerminalToBottom(screen);
});

// Touch-only: keep the prompt above the soft keyboard by shrinking main,
// and keep it shrinking IN SYNC with the keyboard's own slide. iOS fires
// visualViewport.resize once, with the FINAL height, at the end of the
// slide -- never progressively -- so writing that reading straight into
// the CSS variable held the terminal at full size for the whole slide and
// then snapped it (the keyboard-lab blue16 failure). The driver instead
// forecasts the final inset at focus -- the measured height from the
// previous open, persisted so every open after the very first is exact,
// else a fraction of the layout -- and self-animates --keyboard-inset over
// the keyboard's own timing. The honest reading still arrives, but it only
// ever RETARGETS the running move or finishes it with a short glide
// (blue17/20); see terminal-keyboard.js. Android honors
// interactive-widget=resizes-content: the layout shrinks natively, the
// honest reading says 0, and the driver stands down. Desktop is excluded:
// the var is unused outside the mobile media query and a desktop window
// resize is already handled above.
let shownInset = 0; // px of --keyboard-inset currently displayed
let insetFrom = 0;
let insetTo = 0;
let animStart = 0;
let animDur = 0;
let animating = false;
let busyUntil = 0; // rAF stays alive through a transition plus slack
let insetRaf = 0;
let keyboardFocused = false;
// Whether the transcript was pinned to the bottom when focus started: a
// reader parked on the newest line rides the shrink; one who scrolled up
// into history stays there.
let pinnedToBottom = false;
let focusSeq = 0;
let lastResizeSeq = 0;
/** @type {number | undefined} */
let noShowTimer;
/** @type {number | undefined} */
let settleTimer;
let baseLayoutHeight = document.documentElement.clientHeight;
/** @type {import("./terminal-keyboard.js").KeyboardMode} */
let keyboardMode = "unknown";
let storedKeyboardHeight = loadStoredKeyboardHeight();
const iosLike =
  /iP(hone|o(d|ad))/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// Android Chrome gets a native transcript scroller (see the CSS override
// for html[data-oregon-log="native"]): Blink latches a gesture to the
// document scroller the instant one touchmove is not preventDefault-ed,
// so a JS driver racing the compositor on a heavy transcript
// intermittently loses -- and the lost race actuates pull-to-refresh in
// the middle of the log. A native scroller scrolls, chains to the page
// and PTRs by itself, correctly, with no race to lose. iOS keeps the
// driven log (blue29/30): perfect there, untouched here. UA-gated like
// iosLike above -- the measured pan/resize mode is only known after a
// keyboard opens, but scrolling must behave from the first gesture.
const androidLike = /Android/.test(navigator.userAgent);
if (androidLike) {
  document.documentElement.dataset.oregonLog = "native";
}

function loadStoredKeyboardHeight() {
  try {
    return Number(localStorage.getItem(KEYBOARD_HEIGHT_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * @param {number} px
 */
function rememberKeyboardHeight(px) {
  if (px <= 0.5) return;
  storedKeyboardHeight = px;
  try {
    localStorage.setItem(KEYBOARD_HEIGHT_KEY, String(Math.round(px)));
  } catch {
    // Private modes can throw on storage access; the forecast then falls
    // back to the layout estimate on every open, which still retargets.
  }
}

function forgetStoredKeyboardHeight() {
  storedKeyboardHeight = 0;
  try {
    localStorage.removeItem(KEYBOARD_HEIGHT_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

let lastAppliedInset = "";
/**
 * @param {number} px
 */
function applyInset(px) {
  if (!main) return;
  const v = px.toFixed(1);
  if (v === lastAppliedInset) return;
  lastAppliedInset = v;
  main.style.setProperty("--keyboard-inset", `${v}px`);
}

function needInsetFrame() {
  if (!insetRaf) insetRaf = requestAnimationFrame(insetStep);
}

/**
 * @param {number} target
 * @param {number} duration
 * @param {number} now
 */
function driveInsetTo(target, duration, now) {
  insetFrom = shownInset;
  insetTo = target;
  animStart = now;
  animDur = Math.max(40, duration);
  animating = true;
  busyUntil = Math.max(busyUntil, now + animDur + 220);
  needInsetFrame();
}

/**
 * @param {number} now rAF timestamp
 */
function insetStep(now) {
  insetRaf = 0;
  if (animating) {
    const t = Math.min(1, (now - animStart) / animDur);
    shownInset = insetFrom + (insetTo - insetFrom) * easeInOut(t);
    if (t >= 1) {
      shownInset = insetTo;
      animating = false;
    }
  }
  applyInset(shownInset);
  // Keep the transcript glued to the terminal's bottom edge -- where the
  // input line lives -- but ONLY while a keyboard transition window is
  // actually running (blue30). A pull-to-refresh pan fires visualViewport
  // scrolls and hence frames long after the keyboard settled; gluing on
  // focus alone would slam the transcript back down mid-pull. The
  // transcript driver below also clears pinnedToBottom the moment the
  // user scrolls, so no later resize can yank the transcript either.
  if (pinnedToBottom && (animating || now < busyUntil)) {
    scrollTerminalToBottom(screen);
  }
  if (animating || now < busyUntil) needInsetFrame();
}

/**
 * The honest inset reading, or null when there is nothing to act on: no
 * viewport model (desktop), or a pinch (the zoom shrinks the visual
 * viewport in ways the layout must not chase, and the keyboard cannot be
 * open mid-pinch). measureKeyboardInset cancels the currently applied
 * inset out of the geometry, so the reading stays stable while the
 * animation runs.
 * @returns {number | null}
 */
function readHonestInset() {
  const viewport = window.visualViewport;
  if (!viewport || !main) return null;
  if (viewport.scale && Math.abs(viewport.scale - 1) > 0.01) return null;
  return measureKeyboardInset(main, viewport, shownInset);
}

// Pan vs. resize is decided from the measurement, never the UA: a WebKit
// that ever resizes the layout viewport for the keyboard turns the pan
// machinery (the gate, the scroll pin) off by itself. A closed reading
// only re-baselines the layout height for the next comparison.
/**
 * @param {number} reading
 * @returns {import("./terminal-keyboard.js").KeyboardMode}
 */
function detectMode(reading) {
  if (reading > 0.5) {
    keyboardMode = detectKeyboardMode({
      reading,
      layoutHeight: document.documentElement.clientHeight,
      baseLayoutHeight,
    });
    armGate();
  } else {
    baseLayoutHeight = document.documentElement.clientHeight;
  }
  return keyboardMode;
}

function onKeyboardFocus() {
  keyboardFocused = true;
  pinnedToBottom = isPinnedToBottom(screen);
  // Only a focus from a released tap can raise iOS's keyboard. The game's
  // auto-focus (and a visibility-restore) leaves it closed, so forecasting
  // there would shrink the terminal for a keyboard that never comes; the
  // no-show guard would undo it, but the transient shrink is still wrong.
  const fromGesture = focusFromGesture;
  focusFromGesture = false;
  const reading = readHonestInset() ?? 0;
  detectMode(reading);
  if (keyboardMode === "resize") return; // Android: layout already shrank
  if (!fromGesture || !iosLike) return; // desktop: no soft keyboard to match
  rememberKeyboardHeight(reading);
  // Forecast the final inset; the honest vv.resize reading (one burst, at
  // slide end, on iOS) retargets this later.
  const forecast = forecastInset({
    measured: reading,
    stored: storedKeyboardHeight,
    layoutHeight: document.documentElement.clientHeight,
  });
  const seq = ++focusSeq;
  driveInsetTo(forecast, KEYBOARD_SLIDE_MS, performance.now());
  // No-show guard: if no honest reading ever arrives and the visual
  // viewport never shrank, no soft keyboard is coming (hardware keyboard
  // attached, iPad cursor) -- undo the forecast smoothly instead of
  // leaving the terminal stranded small.
  clearTimeout(noShowTimer);
  noShowTimer = setTimeout(() => {
    if (
      keyboardFocused &&
      focusSeq === seq &&
      lastResizeSeq !== seq &&
      (readHonestInset() ?? 0) < 1 &&
      shownInset > 1
    ) {
      driveInsetTo(0, 160, performance.now());
    }
  }, KEYBOARD_SLIDE_MS + 800);
}

function onKeyboardBlur() {
  keyboardFocused = false;
  clearTimeout(noShowTimer);
  driveInsetTo(0, KEYBOARD_SLIDE_MS, performance.now());
}

// One decision path for an honest reading, shared by the resize and scroll
// handlers: settle with a short glide, retarget the running move, or drop
// the reading as mid-slide noise. A reading taken at rest can only
// correct, never contaminate, so every reading also schedules a settle
// re-measure that catches whatever was dropped.
/**
 * @param {number} reading
 */
function applyReading(reading) {
  const now = performance.now();
  const settled = now > busyUntil;
  const mismatch = Math.abs(reading - insetTo) > MISMATCH_PX;
  const extending = keyboardFocused
    ? reading > insetTo - 0.5
    : reading < insetTo + 0.5;
  const late =
    animDur > 0 && (now - animStart) / animDur >= LATE_READING_FRACTION;
  const decision = decideReading({
    settled,
    mismatch,
    extending,
    late,
    focused: keyboardFocused,
  });
  if (decision === "settle") {
    if (Math.abs(reading - shownInset) > SETTLE_EPSILON_PX) {
      driveInsetTo(reading, 120, now);
    }
  } else if (decision === "retarget" || decision === "retarget-late") {
    driveInsetTo(
      reading,
      retargetDuration({ animating, animDur, elapsed: now - animStart }),
      now,
    );
  }
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    const honest = readHonestInset();
    if (honest === null) return;
    detectMode(honest);
    if (Math.abs(honest - shownInset) > SETTLE_EPSILON_PX) {
      driveInsetTo(honest, 120, performance.now());
    }
  }, 450);
}

function onKeyboardViewportResize() {
  if (!usesTouchInput()) return;
  lastResizeSeq = focusSeq;
  const reading = readHonestInset();
  if (reading === null) return; // pinch: hold
  rememberKeyboardHeight(reading);
  detectMode(reading);
  if (keyboardMode === "resize") {
    // Android/native shrink: the layout already moved, so --keyboard-inset
    // must stay 0 or it double-subtracts.
    animating = false;
    shownInset = 0;
    applyInset(0);
    return;
  }
  applyReading(reading);
}

function onKeyboardViewportScroll() {
  if (!usesTouchInput()) return;
  // A pan moves the visible window without changing the keyboard's size.
  // Mid-animation it is noise (the resize handler owns transitions); at
  // rest it can only correct.
  if (performance.now() <= busyUntil) return;
  const reading = readHonestInset();
  if (reading === null) return;
  if (Math.abs(reading - shownInset) > SETTLE_EPSILON_PX) {
    driveInsetTo(reading, 120, performance.now());
  }
}

if (window.visualViewport) {
  // Keyboard show/hide and orientation change both fire resize here; the
  // driver keeps the prompt riding above the keyboard through either.
  window.visualViewport.addEventListener("resize", onKeyboardViewportResize);
  window.visualViewport.addEventListener("scroll", onKeyboardViewportScroll);
}
// Fallback for browsers / WebViews that miss visualViewport events.
let lastInnerWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if (!usesTouchInput()) return;
  if (innerWidth !== lastInnerWidth) {
    // Rotation: the stored keyboard height belongs to the old geometry,
    // and the closed-viewport ratchet to the old orientation.
    lastInnerWidth = innerWidth;
    forgetStoredKeyboardHeight();
    keyboardClosedViewportHeight = 0;
  }
  const reading = readHonestInset();
  if (reading === null) return;
  detectMode(reading);
  driveInsetTo(reading, 160, performance.now());
});

// ================= the north-drag gate (blue14/15, blue24) =================
// WebKit never resizes the layout viewport for the keyboard (bug 259770);
// it pans instead, and the pan range is exactly one keyboard tall. No
// height or overflow on html/body can remove that slack; only a gesture
// can stop a gesture. One non-passive touchmove on document
// preventDefaults a northward drag ONLY when no inner scroller can consume
// it. Southward, horizontal, multi-touch and open selections always pass,
// so bounce, pull-to-refresh and the magnifier stay native. Armed only
// where the page actually pans (measured above, not UA-sniffed), so
// Chrome keeps its scroll fast path.
let gateArmed = false;
let gateTouching = false;
let gateMulti = false;
let gateStartY = 0;
/** @type {Element | null} */
let gateScroller = null;

/**
 * The nearest scrollable ancestor of `node`, or null. The transcript is
 * the only scroller on the page, but the walk stays generic so a drag
 * that starts on any future element is classified the same way.
 * @param {EventTarget | null} node
 * @returns {Element | null}
 */
function scrollerUnder(node) {
  for (
    let n = /** @type {Element | null} */ (node);
    n && n !== document.body && n !== document.documentElement;
    n = n.parentElement
  ) {
    const overflowY = getComputedStyle(n).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return n;
    }
  }
  return null;
}

/**
 * Flatten a scroller to the plain numbers the gate decision consumes.
 * @param {Element} el
 */
function describeScroller(el) {
  const editable = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    editable,
    value: editable ? /** @type {HTMLInputElement} */ (el).value : "",
  };
}

/** @param {TouchEvent} event */
function onGateStart(event) {
  gateTouching = true;
  gateMulti = event.touches.length !== 1;
  if (gateMulti) return;
  gateStartY = event.touches[0].clientY;
  gateScroller = scrollerUnder(event.target);
  // The transcript is a JS-driven scroller (overflow hidden), invisible
  // to the overflow walk above -- but the gate's room check must still
  // see it, or every northward drag over the transcript would be treated
  // as a page pan to block (blue29).
  const target = /** @type {Node | null} */ (event.target);
  if (!gateScroller && target && screen.contains(target)) gateScroller = screen;
}

/** @param {TouchEvent} event */
function onGateMove(event) {
  if (gateMulti || event.touches.length !== 1) return;
  const selection = window.getSelection();
  if (
    document.activeElement === terminalInput &&
    terminalInput.selectionStart !== terminalInput.selectionEnd
  ) {
    return; // a selection drag inside the field stays native
  }
  if (
    shouldBlockNorthDrag({
      deltaY: event.touches[0].clientY - gateStartY,
      multiTouch: false,
      selectionCollapsed: !selection || selection.isCollapsed,
      scroller: gateScroller && describeScroller(gateScroller),
    })
  ) {
    event.preventDefault(); // no chaining, no page pan
  }
}

function onGateEnd() {
  gateTouching = false;
  gateMulti = false;
  gateScroller = null;
  // Momentum out of a scroller outlives the finger; if it chained north
  // anyway, the scroll pin cleans up once it is spent.
  setTimeout(pinScroll, 150);
}

function armGate() {
  if (gateArmed || keyboardMode !== "pan") return;
  gateArmed = true;
  document.addEventListener("touchstart", onGateStart, { passive: true });
  document.addEventListener("touchmove", onGateMove, { passive: false });
  document.addEventListener("touchend", onGateEnd, { passive: true });
  document.addEventListener("touchcancel", onGateEnd, { passive: true });
}

// Residual page scroll (the one-pixel pull-to-refresh token spent
// northward, a focus nudge Chrome applies when the keyboard opens on
// Android, or momentum that chained): reset it once things are quiet, so
// the slack is never left holding the page -- on Android that leftover
// offset is what shifts the fixed column (and can hide the toolbar) when
// the keyboard opens. iOS is covered via the armed gate; Android never
// arms it (resize mode), so the fixed-shell layout gates instead. Desktop
// and touch laptops keep a real scroll range and are excluded. Never while
// a finger is down, never mid-transition -- that fight was blue17's
// oscillation.
function pinScroll() {
  if (
    (!gateArmed && !usesFixedShell.matches) ||
    gateTouching ||
    window.scrollY <= 0
  )
    return;
  // iOS only: never mid-transition -- resetting the page while the inset
  // animation runs fed back into the measurement and oscillated (blue17).
  // Android (resize mode, gate never armed) drives no inset animation, so
  // the pin applies immediately: that keeps a focus nudge from lingering
  // long enough to hide the toolbar and shift the whole column upward on
  // keyboard open. The reset itself cannot loop: once scrollY is back at 0
  // there is no further scroll event, and visualViewport handlers ignore
  // frames inside the transition window anyway.
  if (gateArmed && performance.now() < busyUntil + 260) return;
  window.scrollTo(0, 0);
}
window.addEventListener("scroll", pinScroll, { passive: true });

// ================= the transcript driver (blue29/30) =================
// Inside the touch shell the transcript is NOT a native scroller:
// #screen is overflow:hidden there, so it cannot rubber-band, cannot
// chain, and has no overscroll physics of any kind -- no matter where a
// gesture starts (WebKit decides a gesture's overscroll up front, so
// overscroll-behavior could not cover a drag that ARRIVES at an edge
// mid-gesture; blue26-28 shipped the evidence). All log movement is
// driven here, clamped and pixel-rounded on every write: the ends are
// hard BY CONSTRUCTION. Momentum after a flick is emulated (native
// momentum needs a scroller; this has none). Outside the shell (desktop,
// touch laptops) the transcript is a native scroller again and the
// driver stands aside entirely -- see the touchmove/wheel gates below --
// so the browser scrolls and chains by itself, as before 9dea85f. (Android
// inside the shell is native as well: see androidLike above.) One
// writer per platform: driving over a native scroller fought the
// scrolling thread and left the page nervous.
//
// A southward drag that finds the log at its top is nobody's scroll: the
// driver never preventDefaults those moves, so the document -- sitting at
// scroll 0 -- runs the browser's OWN pull-to-refresh, keyboard open or
// closed. A pull that arrives at the top mid-gesture keeps driving the
// hard 0 through a small dead zone, then hands the gesture to the page
// and LATCHES the hand-off: no re-driving that gesture, so the page pull
// can never fight the log again. On iOS, which locks a touch to its first
// scroll owner, such a pull stops dead -- abruptly, with no stretch; the
// next touch from the top is a full native pull. That abrupt stop is the
// accepted worst case.
let logTouch = false;
let logY0 = 0;
let logTop0 = 0;
let logDriven = false; // this gesture drove the log (a flick is possible)
let logHandOff = false; // top arrival latched: the page owns the gesture
let logMomentumRaf = 0;
let logVelocity = 0;
let logMomentumT0 = 0;
/** @type {Array<{ t: number, st: number }>} */
const logSamples = [];

function logRoom() {
  return screen.scrollHeight - screen.clientHeight;
}

function logStopMomentum() {
  if (logMomentumRaf) cancelAnimationFrame(logMomentumRaf);
  logMomentumRaf = 0;
  logVelocity = 0;
}

/**
 * @param {number} now rAF timestamp
 */
function logMomentumStep(now) {
  logMomentumRaf = 0;
  const step = momentumStep({
    scrollTop: screen.scrollTop,
    velocity: logVelocity,
    dtMs: now - logMomentumT0,
    room: logRoom(),
  });
  logMomentumT0 = now;
  logVelocity = step.velocity;
  screen.scrollTop = step.scrollTop;
  if (step.running) logMomentumRaf = requestAnimationFrame(logMomentumStep);
}

function logRelease() {
  const velocity = flickVelocity(logSamples);
  if (velocity === 0) return;
  logVelocity = velocity;
  logMomentumT0 = performance.now();
  logMomentumRaf = requestAnimationFrame(logMomentumStep);
}

function logGestureEnd() {
  if (logTouch && logDriven && !logHandOff) logRelease();
  logTouch = false;
  logDriven = false;
  logHandOff = false;
  logSamples.length = 0;
}

screen.addEventListener(
  "touchstart",
  (e) => {
    logStopMomentum();
    logTouch = e.touches.length === 1;
    if (!logTouch) return;
    logY0 = e.touches[0].clientY;
    logTop0 = Math.round(screen.scrollTop);
    logDriven = false;
    logHandOff = false;
    logSamples.length = 0;
  },
  { passive: true },
);

screen.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length !== 1) {
      // Pinch or a second finger: hands off; the page can have it.
      logTouch = false;
      logDriven = false;
      logHandOff = false;
      logStopMomentum();
      return;
    }
    if (!logTouch) return;
    // Off the touch shell the transcript scrolls natively and chains to
    // the page by itself: stand aside so the browser runs the gesture
    // instead of driving over it.
    if (!usesFixedShell.matches) return;
    // Android inside the shell is native too (see androidLike above): a
    // preventDefault here would only race the compositor -- and losing
    // that race is what actuated pull-to-refresh mid-log. Still release
    // the keyboard glue: the user took the transcript over.
    if (androidLike) {
      pinnedToBottom = false;
      return;
    }
    const dy = e.touches[0].clientY - logY0;
    const selection = window.getSelection();
    const room = logRoom();
    const move = decideLogMove({
      dy,
      top0: logTop0,
      room,
      handOff: logHandOff,
      selectionCollapsed: !selection || selection.isCollapsed,
    });
    if (move.action === "page") return;
    e.preventDefault(); // the log consumes this move; the page must not
    if (move.action === "top") {
      screen.scrollTop = 0;
      pinnedToBottom = false; // the user scrolled: release the keyboard glue
      if (move.latch) logHandOff = true;
      return;
    }
    const target = drivenScrollTop({ top0: logTop0, dy, room });
    logDriven = true;
    pinnedToBottom = false; // the user scrolled: release the keyboard glue
    screen.scrollTop = target;
    logSamples.push({ t: performance.now(), st: target });
    if (logSamples.length > 4) logSamples.shift();
  },
  { passive: false },
);

screen.addEventListener("touchend", logGestureEnd, { passive: true });
screen.addEventListener("touchcancel", logGestureEnd, { passive: true });

// Desktop and touch laptops: the transcript is a native scroller (see the
// base #screen rule), so wheel gestures scroll it natively and a spent end
// chains to the outer page by itself -- the pre-9dea85f contract. The
// driver below runs only inside the touch shell, where the transcript is
// not a scroller and every write is emulated. No scrollBy inside the
// handler: on Safari, programmatic page scroll during active wheel
// momentum fights the scrolling thread and the page wiggles. Line/page
// delta modes are converted to pixels (decideLogWheel).
screen.addEventListener(
  "wheel",
  (e) => {
    if (!usesFixedShell.matches) return; // native scroll + native chain
    const room = logRoom();
    if (room <= 1) return; // short log: the wheel belongs to the page
    const move = decideLogWheel({
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      scrollTop: screen.scrollTop,
      room,
      pageHeight: window.innerHeight,
    });
    pinnedToBottom = false; // the user scrolled: release the keyboard glue
    screen.scrollTop = move.scrollTop;
    if (move.prevent) e.preventDefault(); // the log consumed it all
  },
  { passive: false },
);

terminalInput.addEventListener("focus", () => {
  render();
  // At focus time the keyboard is (nearly) always still closed, so this is
  // the reliable moment to record the unobstructed viewport height.
  keyboardClosedViewportHeight = Math.max(
    keyboardClosedViewportHeight,
    keyboardViewport.height ?? window.innerHeight,
  );
  onKeyboardFocus();
});
terminalInput.addEventListener("blur", () => {
  onKeyboardBlur();
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

  // The engine buffer stores one byte per character, so the line is
  // normalized to printable ASCII exactly here -- the single policy choke
  // point after the faithful forwarding that fed it.
  const value = `${toEngineText(currentInput)}\n`;
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

// True for the focus() calls that can raise a soft keyboard on iOS: the
// ones made inside a released tap. The driver forecasts only for these.
let focusFromGesture = false;

function focusTerminalInput({ force = false } = {}) {
  if (!waitingForInput) return;
  if (document.activeElement === terminalInput) {
    // iOS can leave the field focused without ever showing the soft
    // keyboard. Re-focusing it then does nothing, so on a tap (a real
    // gesture) blur first: the following focus() is an activation again
    // and iOS opens the keyboard.
    if (!force || !needsSoftKeyboardFocus()) return;
    focusFromGesture = true;
    terminalInput.blur();
  } else if (force) {
    focusFromGesture = true;
  }
  // preventScroll: focusing must never yank the viewport around; opening the
  // keyboard itself may, which is Safari's own behavior and left alone.
  terminalInput.focus({ preventScroll: true });
  retakeCaret();
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

// --- the command line ---------------------------------------------------------
//
// The hidden field owns the text: the browser and its IME edit it, and the
// launcher only reads. Every change is echoed to the visible line, and the
// caret is re-pinned to the end so editing stays append-only. While an IME
// composition is active the field is hands-off -- no value writes, no caret
// moves: composed text REPLACES the character it accents, so touching the
// field under the IME corrupts the marked range and every update then
// re-inserts the whole composition instead (AÁASASS...), while stripping it
// deletes the base letter outright (the original vanishing-character bug).
// The game's ASCII policy applies exactly once, at submit (toEngineText).

let composing = false;

terminalInput.addEventListener("compositionstart", () => {
  composing = true;
});

terminalInput.addEventListener("compositionend", () => {
  composing = false;
  // The IME handed the text over; re-echo the committed line and take the
  // caret back for append-only editing.
  if (waitingForInput) {
    echoLiveInput();
    retakeCaret();
  }
});

terminalInput.addEventListener("input", (event) => {
  if (!waitingForInput) return;

  // Mobile keyboards often insert a newline (\n) or trigger insertLineBreak
  // instead of an 'Enter' keydown event. The final input event's characters
  // ride along in the field value, so take the live text, not the stale
  // last echo; the newline itself is the submit signal, never part of the
  // line (toEngineText drops it).
  if (
    /** @type {InputEvent} */ (event).inputType === "insertLineBreak" ||
    terminalInput.value.includes("\n")
  ) {
    currentInput = liveInputText();
    submitInput();
    return;
  }

  echoLiveInput();
  retakeCaret();
});

// Handle desktop 'Enter' key press. An Enter that belongs to an IME
// composition (keyCode 229 is the legacy Android signal for it) commits the
// marked text; submitting here would clear the field mid-composition. The
// commit lands through compositionend above, and the next Enter submits.
terminalInput.addEventListener("keydown", (event) => {
  if (
    waitingForInput &&
    event.key === "Enter" &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault();
    submitInput();
  }
});

/**
 * The live line for display and submit, from the field's faithful value:
 * upper-cased for the terminal and capped at the engine's line length.
 * @returns {string}
 */
function liveInputText() {
  return terminalInput.value.toUpperCase().slice(0, maxInputLength);
}

/** Echoes the field's current text to the terminal's input line. */
function echoLiveInput() {
  currentInput = liveInputText();
  render();
  scrollTerminalToBottom(screen);
}

/**
 * Re-pins the caret to the end of the field (append-only editing). Never
 * under an active composition: the IME owns the selection while its text is
 * marked, and a selection write under it turns every composition update
 * into an insertion of the full pending text.
 */
function retakeCaret() {
  if (!composing) moveInputCaretToEnd(terminalInput);
}

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
