// Unit tests for the pure helpers in web/terminal-scroll.js. These do not
// need a DOM: isPinnedToBottom is pure arithmetic, and measureKeyboardInset
// takes plain stubs for the anchor and viewport so the geometry can be
// driven deterministically. The self-correcting property of the inset
// formula (the heart of the keyboard-shrink fix) is verified here.
//
//   node --test scripts/terminal-scroll.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  isPinnedToBottom,
  measureKeyboardInset,
  scrollTerminalToBottom,
} from "../web/terminal-scroll.js";

/** Build a fake anchor element with a controllable bottom. */
function anchor(bottom) {
  return { getBoundingClientRect: () => ({ bottom }) };
}

/** Build a fake visualViewport. */
function viewport({ height, offsetTop = 0, scale = 1 } = {}) {
  return { height, offsetTop, scale };
}

test("isPinnedToBottom: at the bottom within the tolerance", () => {
  assert.equal(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }), true);
  assert.equal(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 500, scrollTop: 499 }), true);
});

test("isPinnedToBottom: scrolled up is not pinned", () => {
  assert.equal(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 500, scrollTop: 100 }), false);
  // No overflow is trivially pinned: there is nothing to scroll above, so
  // a re-scroll is a no-op and safe to perform automatically.
  assert.equal(isPinnedToBottom({ scrollHeight: 500, clientHeight: 500, scrollTop: 0 }), true);
});

test("scrollTerminalToBottom: only writes when overflowing", () => {
  const noOverflow = { scrollHeight: 500, clientHeight: 500, scrollTop: 0 };
  scrollTerminalToBottom(noOverflow);
  assert.equal(noOverflow.scrollTop, 0, "no-op when not overflowing");

  const overflows = { scrollHeight: 1200, clientHeight: 500, scrollTop: 0 };
  scrollTerminalToBottom(overflows);
  assert.equal(overflows.scrollTop, 1200);
});

test("measureKeyboardInset: returns 0 when no viewport", () => {
  assert.equal(measureKeyboardInset(anchor(828), null, 0), 0);
  assert.equal(measureKeyboardInset(anchor(828), undefined, 0), 0);
});

test("measureKeyboardInset: returns 0 while pinch-zoomed", () => {
  // The zoom shrinks the visual viewport in ways the layout should not
  // chase, so the inset stays at 0 regardless of how much is hidden.
  assert.equal(measureKeyboardInset(anchor(828), viewport({ height: 400, scale: 1.5 }), 0), 0);
  assert.equal(measureKeyboardInset(anchor(828), viewport({ height: 400, scale: 0.9 }), 0), 0);
});

test("measureKeyboardInset: nothing hidden -> 0", () => {
  // visible bottom (844) is below the natural bottom (828): no inset.
  assert.equal(
    measureKeyboardInset(anchor(828), viewport({ height: 844, offsetTop: 0 }), 0),
    0,
  );
});

test("measureKeyboardInset: hidden portion -> positive inset", () => {
  // Natural bottom 828, visible bottom 544 (keyboard up): 284 px hidden.
  assert.equal(
    measureKeyboardInset(anchor(828), viewport({ height: 544, offsetTop: 0 }), 0),
    284,
  );
});

test("measureKeyboardInset: clamps negative deltas to 0", () => {
  // Floating-point or edge cases must never yield a negative inset that
  // would grow the layout past its base size.
  assert.equal(
    measureKeyboardInset(anchor(827.4), viewport({ height: 828, offsetTop: 0 }), 0),
    0,
  );
});

test("measureKeyboardInset: self-corrects in one step (no oscillation)", () => {
  // The crucial property: passing the value we just measured back in
  // alongside the shrunken rect must reproduce the same value, so the
  // "shrink -> measure -> shrink more" loop settles immediately rather
  // than thrashing.
  const vv = viewport({ height: 544, offsetTop: 0 });
  const first = measureKeyboardInset(anchor(828), vv, 0);
  assert.equal(first, 284);

  // Apply: the anchor's bottom moves up by exactly the inset.
  const applied = anchor(828 - first);
  // Re-measure with the applied inset as currentInset: the natural bottom
  // reconstructed from (rect.bottom + currentInset) is the same 828, so
  // the result is identical to the first measure.
  const second = measureKeyboardInset(applied, vv, first);
  assert.equal(second, first, "second measure equals first (stable)");

  // A third call after another (no-op) apply is still the same.
  const third = measureKeyboardInset(applied, vv, second);
  assert.equal(third, first);
});

test("measureKeyboardInset: tracks visible-bottom changes from panning", () => {
  // Panning the visual viewport (offsetTop changes) shifts the visible
  // region in client coordinates. visibleBottom = offsetTop + height.
  // The inset tracks the new hidden amount, which is what the page
  // actually sees of the keyboard vs. the element.
  const height = 544;
  assert.equal(
    measureKeyboardInset(anchor(828), viewport({ height, offsetTop: 0 }), 0),
    828 - 544,
  );
  assert.equal(
    measureKeyboardInset(anchor(828), viewport({ height, offsetTop: 100 }), 0),
    828 - (100 + height),
  );
});
