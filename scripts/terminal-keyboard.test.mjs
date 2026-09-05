// Unit tests for the pure decision helpers in web/terminal-keyboard.js.
// These need no DOM: the helpers take plain numbers and stubs so the soft-
// keyboard contract distilled from keyboard-lab/blue24 can be driven
// deterministically. The launcher owns the DOM wiring and the rAF loop;
// everything decided here is what keeps the terminal shrinking in sync
// with the keyboard, the page undraggable north, and pull-to-refresh
// alive.
//
//   node --test scripts/terminal-keyboard.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAG_TREMOR_PX,
  decideReading,
  detectKeyboardMode,
  easeInOut,
  forecastInset,
  retargetDuration,
  shouldBlockNorthDrag,
} from "../web/terminal-keyboard.js";

test("easeInOut: endpoints and midpoint", () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(0.5), 0.5);
});

test("easeInOut: symmetric and never overshoots", () => {
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const v = easeInOut(t);
    assert.ok(v >= 0 && v <= 1, `easeInOut(${t}) = ${v} must stay in [0,1]`);
    assert.ok(Math.abs(easeInOut(t) + easeInOut(1 - t) - 1) < 1e-9, "symmetric");
    // Monotonic: the animated edge must never move backwards.
    if (i > 0) assert.ok(v >= easeInOut((i - 1) / 20), "monotonic");
  }
});

test("forecastInset: measured reading wins over everything", () => {
  assert.equal(
    forecastInset({ measured: 300, stored: 280, layoutHeight: 844 }),
    300,
  );
});

test("forecastInset: stored height wins over the estimate", () => {
  assert.equal(
    forecastInset({ measured: 0, stored: 284, layoutHeight: 844 }),
    284,
  );
});

test("forecastInset: true first open falls back to the layout estimate", () => {
  assert.equal(
    forecastInset({ measured: 0, stored: 0, layoutHeight: 844 }),
    Math.round(844 * 0.42),
  );
  assert.equal(
    forecastInset({ measured: 0, stored: 0, layoutHeight: 800, estFraction: 0.5 }),
    400,
  );
});

test("detectKeyboardMode: a closed reading never decides", () => {
  assert.equal(
    detectKeyboardMode({ reading: 0, layoutHeight: 800, baseLayoutHeight: 844 }),
    "unknown",
  );
  assert.equal(
    detectKeyboardMode({ reading: 0.4, layoutHeight: 800, baseLayoutHeight: 844 }),
    "unknown",
  );
});

test("detectKeyboardMode: layout shrank for the keyboard -> resize", () => {
  // Android honors interactive-widget=resizes-content: the layout viewport
  // itself shrinks, so the driver must stand down (--keyboard-inset at 0).
  assert.equal(
    detectKeyboardMode({ reading: 300, layoutHeight: 544, baseLayoutHeight: 844 }),
    "resize",
  );
});

test("detectKeyboardMode: layout unchanged -> pan (WebKit keyboard slack)", () => {
  assert.equal(
    detectKeyboardMode({ reading: 300, layoutHeight: 844, baseLayoutHeight: 844 }),
    "pan",
  );
  // Toolbar jitter of a few px must not flip the classification.
  assert.equal(
    detectKeyboardMode({ reading: 300, layoutHeight: 842, baseLayoutHeight: 844 }),
    "pan",
  );
});

// The decision matrix behind "shrinks in sync": settled readings glide,
// extending readings retarget at any phase, opposing ones only late, and
// early opposing noise is dropped.
test("decideReading: settled readings always settle", () => {
  assert.equal(
    decideReading({ settled: true, mismatch: false, extending: true, late: false, focused: true }),
    "settle",
  );
  assert.equal(
    decideReading({ settled: true, mismatch: true, extending: false, late: false, focused: false }),
    "settle",
  );
});

test("decideReading: an extending reading is trusted at any phase", () => {
  // Partial height reports mid-slide only ever under-report, so a reading
  // that pushes the move further in its own direction cannot overshoot.
  assert.equal(
    decideReading({ settled: false, mismatch: true, extending: true, late: false, focused: true }),
    "retarget",
  );
  assert.equal(
    decideReading({ settled: false, mismatch: true, extending: true, late: true, focused: false }),
    "retarget",
  );
});

test("decideReading: an opposing reading is trusted only late (and focused)", () => {
  // WebKit's single end-of-slide burst lands late in the animation; an
  // earlier reading against the direction is transient noise.
  assert.equal(
    decideReading({ settled: false, mismatch: true, extending: false, late: true, focused: true }),
    "retarget-late",
  );
  assert.equal(
    decideReading({ settled: false, mismatch: true, extending: false, late: false, focused: true }),
    "drop",
  );
  // Without focus (a close animation) the late path is not taken: blur
  // already commands the move toward 0.
  assert.equal(
    decideReading({ settled: false, mismatch: true, extending: false, late: true, focused: false }),
    "drop",
  );
});

test("decideReading: sub-threshold readings never disturb the move", () => {
  assert.equal(
    decideReading({ settled: false, mismatch: false, extending: true, late: false, focused: true }),
    "drop",
  );
});

test("retargetDuration: a running move bends over its remaining time", () => {
  assert.equal(
    retargetDuration({ animating: true, animDur: 250, elapsed: 100 }),
    150,
  );
  // Never below the floor, however late the reading.
  assert.equal(
    retargetDuration({ animating: true, animDur: 250, elapsed: 240 }),
    60,
  );
});

test("retargetDuration: a finished move takes the short settle glide", () => {
  assert.equal(
    retargetDuration({ animating: false, animDur: 250, elapsed: 300 }),
    120,
  );
});

// The north-drag gate: only a gesture can stop a gesture, and it must
// stop exactly the drags nothing else can consume.
/**
 * @param {number} scrollTop
 * @param {{ editable?: boolean, value?: string }} [opts]
 */
function scroller(scrollTop, { editable = false, value = "" } = {}) {
  return { scrollTop, scrollHeight: 1200, clientHeight: 500, editable, value };
}

test("shouldBlockNorthDrag: southward drags and tremor always pass", () => {
  const open = scroller(700); // at its end: the classic block case
  assert.equal(
    shouldBlockNorthDrag({ deltaY: 100, multiTouch: false, selectionCollapsed: true, scroller: open }),
    false,
  );
  for (let dy = DRAG_TREMOR_PX; dy > -DRAG_TREMOR_PX; dy--) {
    assert.equal(
      shouldBlockNorthDrag({ deltaY: dy, multiTouch: false, selectionCollapsed: true, scroller: open }),
      false,
      `deltaY=${dy} must pass`,
    );
  }
  // At exactly the tremor distance northward the gate takes over.
  assert.equal(
    shouldBlockNorthDrag({ deltaY: -DRAG_TREMOR_PX, multiTouch: false, selectionCollapsed: true, scroller: open }),
    true,
  );
});

test("shouldBlockNorthDrag: pinch and open selections always pass", () => {
  const open = scroller(700);
  assert.equal(
    shouldBlockNorthDrag({ deltaY: -200, multiTouch: true, selectionCollapsed: true, scroller: open }),
    false,
  );
  assert.equal(
    shouldBlockNorthDrag({ deltaY: -200, multiTouch: false, selectionCollapsed: false, scroller: open }),
    false,
  );
});

test("shouldBlockNorthDrag: no scroller under the finger -> block", () => {
  // The page background has no scroller to consume the drag; unblocked it
  // pans the whole page into WebKit's keyboard slack.
  assert.equal(
    shouldBlockNorthDrag({ deltaY: -200, multiTouch: false, selectionCollapsed: true, scroller: null }),
    true,
  );
});

test("shouldBlockNorthDrag: a scroller with room consumes the drag", () => {
  // Reading history: the transcript scrolls internally, the page never moves.
  assert.equal(
    shouldBlockNorthDrag({ deltaY: -200, multiTouch: false, selectionCollapsed: true, scroller: scroller(100) }),
    false,
  );
  // One px of headroom below the strict threshold still consumes (the
  // tolerance keeps a parked-at-end scroller from chaining).
  assert.equal(
    shouldBlockNorthDrag({ deltaY: -200, multiTouch: false, selectionCollapsed: true, scroller: scroller(698) }),
    false,
  );
});

test("shouldBlockNorthDrag: a scroller at its end cannot consume -> block", () => {
  assert.equal(
    shouldBlockNorthDrag({ deltaY: -200, multiTouch: false, selectionCollapsed: true, scroller: scroller(700) }),
    true,
  );
});

test("shouldBlockNorthDrag: an empty editable never counts as consumable", () => {
  // Its placeholder inflates scrollHeight, so it would always look like it
  // had room and the page could be dragged out from under the prompt.
  assert.equal(
    shouldBlockNorthDrag({
      deltaY: -200,
      multiTouch: false,
      selectionCollapsed: true,
      scroller: scroller(0, { editable: true, value: "" }),
    }),
    true,
  );
  // A non-empty editable scrolls like any other scroller.
  assert.equal(
    shouldBlockNorthDrag({
      deltaY: -200,
      multiTouch: false,
      selectionCollapsed: true,
      scroller: scroller(0, { editable: true, value: "open lamp" }),
    }),
    false,
  );
});
