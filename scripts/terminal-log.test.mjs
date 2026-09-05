// Unit tests for the pure helpers in web/terminal-log.js -- the transcript
// driver distilled from keyboard-lab/blue30/31. These need no DOM: the move
// classifier, the wheel decision, the flick velocity, and the momentum step
// take plain numbers so the log's contract can be driven deterministically:
//
//   - a southward pull that finds the log at its top is the PAGE's
//     (native pull-to-refresh), from the first pixel or latched after a
//     mid-gesture arrival past the dead zone;
//   - everything the log drives is clamped to [0, room] and rounded to
//     whole pixels, so the ends are hard by construction (no rubber band,
//     from a drag, a flick, or a wheel, from any starting position);
//   - a wheel delta that would overshoot past an end is NOT
//     preventDefault-ed: the surplus chains to the outer page natively
//     (blue31).
//
//   node --test scripts/terminal-log.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  FLICK_DECAY,
  FLICK_MAX_VELOCITY,
  HANDOFF_DEAD_ZONE_PX,
  WHEEL_LINE_PX,
  decideLogMove,
  decideLogWheel,
  drivenScrollTop,
  flickVelocity,
  momentumStep,
} from "../web/terminal-log.js";

/** A southward pull arriving at the top from a mid-log start. */
const ARRIVAL = { dy: 100, top0: 50, room: 400, handOff: false, selectionCollapsed: true };

test("decideLogMove: a latched hand-off is never re-driven", () => {
  // blue30: once the page owns the gesture it owns it, period -- no
  // flip-flopping between drive and hand-off while the finger trembles.
  assert.deepEqual(
    decideLogMove({ ...ARRIVAL, handOff: true }),
    { action: "page" },
  );
  // Even a move that would drive deep into the log.
  assert.deepEqual(
    decideLogMove({ dy: -80, top0: 0, room: 400, handOff: true, selectionCollapsed: true }),
    { action: "page" },
  );
});

test("decideLogMove: a short log is the page's", () => {
  // Nothing to scroll: the driver stands aside entirely.
  assert.deepEqual(
    decideLogMove({ ...ARRIVAL, room: 1 }),
    { action: "page" },
  );
  assert.deepEqual(
    decideLogMove({ dy: -40, top0: 0, room: 0, handOff: false, selectionCollapsed: true }),
    { action: "page" },
  );
});

test("decideLogMove: a selection drag is not a scroll", () => {
  assert.deepEqual(
    decideLogMove({ ...ARRIVAL, selectionCollapsed: false }),
    { action: "page" },
  );
});

test("decideLogMove: a pull that BEGAN at the top is the page's from the first pixel", () => {
  // The log is at its top and the finger moves south: nobody's scroll --
  // never preventDefault-ed, so Safari's own pull-to-refresh runs.
  assert.deepEqual(
    decideLogMove({ dy: 3, top0: 0, room: 400, handOff: false, selectionCollapsed: true }),
    { action: "page" },
  );
  assert.deepEqual(
    decideLogMove({ dy: 200, top0: 0, room: 400, handOff: false, selectionCollapsed: true }),
    { action: "page" },
  );
});

test("decideLogMove: a northward drag from the top drives back into the log", () => {
  assert.deepEqual(
    decideLogMove({ dy: -30, top0: 0, room: 400, handOff: false, selectionCollapsed: true }),
    { action: "drive" },
  );
});

test("decideLogMove: a pull arriving at the top stays hard inside the dead zone", () => {
  // top0 - dy == 0 exactly (dy 50 from top0 50): the hard 0, no latch yet.
  assert.deepEqual(
    decideLogMove({ ...ARRIVAL, dy: 50 }),
    { action: "top", latch: false },
  );
  // One px inside the zone: still driven.
  assert.deepEqual(
    decideLogMove({ ...ARRIVAL, dy: 50 + HANDOFF_DEAD_ZONE_PX - 1 }),
    { action: "top", latch: false },
  );
  // Past the zone: the gesture is handed to the page and LATCHED.
  assert.deepEqual(
    decideLogMove({ ...ARRIVAL, dy: 50 + HANDOFF_DEAD_ZONE_PX }),
    { action: "top", latch: true },
  );
  // A fast pull from deep in the log can hand off on its first move.
  assert.deepEqual(
    decideLogMove({ dy: 500, top0: 300, room: 400, handOff: false, selectionCollapsed: true }),
    { action: "top", latch: true },
  );
});

test("decideLogMove: an ordinary mid-log move drives", () => {
  assert.deepEqual(
    decideLogMove({ dy: 40, top0: 200, room: 400, handOff: false, selectionCollapsed: true }),
    { action: "drive" },
  );
  assert.deepEqual(
    decideLogMove({ dy: -40, top0: 200, room: 400, handOff: false, selectionCollapsed: true }),
    { action: "drive" },
  );
  // A zero-delta first move already belongs to the log: it must not let
  // the gesture leak to the page before the direction is known.
  assert.deepEqual(
    decideLogMove({ dy: 0, top0: 200, room: 400, handOff: false, selectionCollapsed: true }),
    { action: "drive" },
  );
});

test("drivenScrollTop: clamped to [0, room] and whole-pixel", () => {
  assert.equal(drivenScrollTop({ top0: 200, dy: 50, room: 400 }), 150);
  assert.equal(drivenScrollTop({ top0: 30, dy: 300, room: 400 }), 0, "top is hard");
  assert.equal(drivenScrollTop({ top0: 390, dy: -300, room: 400 }), 400, "end is hard");
  // Fractional clientY (iOS) must never write a fractional scrollTop:
  // subpixel writes shimmered the last few px before a stop (blue30).
  assert.equal(
    Number.isInteger(drivenScrollTop({ top0: 10, dy: -10.37, room: 400 })),
    true,
  );
  assert.equal(drivenScrollTop({ top0: 10, dy: -10.37, room: 400 }), 20);
});

// --- the wheel (blue31: surplus chains to the outer page) -------------------
test("decideLogWheel: a delta that fits inside the log is consumed", () => {
  assert.deepEqual(
    decideLogWheel({ deltaY: 50, scrollTop: 100, room: 400 }),
    { scrollTop: 150, prevent: true },
  );
  // Exactly onto an end still fits: consumed, no page scroll.
  assert.deepEqual(
    decideLogWheel({ deltaY: 10, scrollTop: 390, room: 400 }),
    { scrollTop: 400, prevent: true },
  );
  assert.deepEqual(
    decideLogWheel({ deltaY: -5, scrollTop: 5, room: 400 }),
    { scrollTop: 0, prevent: true },
  );
});

test("decideLogWheel: an overshoot clamps the log and chains to the page", () => {
  // Past the end: the log lands exactly on the edge, and the event is NOT
  // prevented -- the browser scrolls the outer page with the surplus.
  assert.deepEqual(
    decideLogWheel({ deltaY: 30, scrollTop: 390, room: 400 }),
    { scrollTop: 400, prevent: false },
  );
  // Past the top (scrolling back up): same contract, other end.
  assert.deepEqual(
    decideLogWheel({ deltaY: -30, scrollTop: 5, room: 400 }),
    { scrollTop: 0, prevent: false },
  );
});

test("decideLogWheel: a short log chains every wheel to the page", () => {
  // room 0/1 leaves no delta to consume; the caller already stood aside
  // for room <= 1, and the helper's clamp is a hard edge either way.
  assert.deepEqual(
    decideLogWheel({ deltaY: -40, scrollTop: 0, room: 0 }),
    { scrollTop: 0, prevent: false },
  );
  assert.deepEqual(
    decideLogWheel({ deltaY: 40, scrollTop: 1, room: 1 }),
    { scrollTop: 1, prevent: false },
  );
});

test("decideLogWheel: line-mode deltas are converted to pixels", () => {
  // deltaMode 1 (classic mouse notches): one notch = 16 CSS px.
  assert.deepEqual(
    decideLogWheel({ deltaY: 3, deltaMode: 1, scrollTop: 50, room: 400 }),
    { scrollTop: 50 + 3 * WHEEL_LINE_PX, prevent: true },
  );
  // The conversion decides the overshoot, not the raw notch count.
  assert.deepEqual(
    decideLogWheel({ deltaY: -30, deltaMode: 1, scrollTop: 10, room: 400 }),
    { scrollTop: 0, prevent: false },
  );
});

test("decideLogWheel: page-mode deltas are converted to pixels", () => {
  // deltaMode 2 (Page Down/Up): one page = the viewport height.
  assert.deepEqual(
    decideLogWheel({ deltaY: 1, deltaMode: 2, scrollTop: 300, room: 800, pageHeight: 844 }),
    { scrollTop: 800, prevent: false },
  );
  assert.deepEqual(
    decideLogWheel({ deltaY: -1, deltaMode: 2, scrollTop: 100, room: 800, pageHeight: 844 }),
    { scrollTop: 0, prevent: false },
  );
});

test("decideLogWheel: every written scrollTop is a whole pixel", () => {
  // Fractional trackpad deltas (Safari) must never write a fractional
  // scrollTop: the shimmer fix applies to the wheel path too (blue30).
  for (const dy of [0.5, -10.37, 8.9]) {
    const st = decideLogWheel({ deltaY: dy, scrollTop: 10, room: 400 });
    assert.equal(Number.isInteger(st.scrollTop), true, `deltaY=${dy}`);
  }
  assert.deepEqual(
    decideLogWheel({ deltaY: 10.5, scrollTop: 100, room: 400 }),
    { scrollTop: 111, prevent: true },
  );
});

/** @param {number[]} sts driven scrollTop samples, 16.667ms apart (one frame) */
function samples(sts) {
  return sts.map((st, i) => ({ t: i * 16.667, st }));
}

test("flickVelocity: converts px/ms to px per 16.667ms frame", () => {
  // 1px/ms * 16.667 = 16.667 px/frame.
  const v = flickVelocity(samples([100, 116.667]));
  assert.ok(Math.abs(v - 16.667) < 1e-9, `got ${v}`);
});

test("flickVelocity: clamps to the cap in both directions", () => {
  assert.equal(flickVelocity(samples([0, 500])), FLICK_MAX_VELOCITY);
  assert.equal(flickVelocity(samples([500, 0])), -FLICK_MAX_VELOCITY);
});

test("flickVelocity: a slow release is not a flick", () => {
  assert.equal(flickVelocity(samples([100, 100.5])), 0);
});

test("flickVelocity: nothing to launch from", () => {
  assert.equal(flickVelocity([]), 0);
  assert.equal(flickVelocity([{ t: 0, st: 10 }]), 0);
  // Two samples with the same timestamp: no dt, no velocity.
  assert.equal(flickVelocity([{ t: 5, st: 10 }, { t: 5, st: 40 }]), 0);
});

test("momentumStep: decays one frame at 16.667ms by the decay factor", () => {
  const s = momentumStep({ scrollTop: 100, velocity: 10, dtMs: 16.667, room: 400 });
  assert.ok(Math.abs(s.velocity - 10 * FLICK_DECAY) < 1e-9, `got ${s.velocity}`);
  // scrollTop = 100 + 8.8 * 1 frame.
  assert.ok(Math.abs(s.scrollTop - Math.round(108.8)) < 1, `got ${s.scrollTop}`);
  assert.equal(s.running, true);
});

test("momentumStep: clamps long frames so a stutter cannot jump", () => {
  // 500ms since the last frame: the decay and integration use 48ms.
  const clamped = momentumStep({ scrollTop: 100, velocity: 10, dtMs: 500, room: 400 });
  const at48 = momentumStep({ scrollTop: 100, velocity: 10, dtMs: 48, room: 400 });
  assert.equal(clamped.scrollTop, at48.scrollTop);
});

test("momentumStep: hard stop at the top", () => {
  const s = momentumStep({ scrollTop: 2, velocity: -30, dtMs: 16.667, room: 400 });
  assert.equal(s.scrollTop, 0);
  assert.equal(s.velocity, 0);
  assert.equal(s.running, false);
});

test("momentumStep: hard stop at the end", () => {
  const s = momentumStep({ scrollTop: 395, velocity: 30, dtMs: 16.667, room: 400 });
  assert.equal(s.scrollTop, 400);
  assert.equal(s.velocity, 0);
  assert.equal(s.running, false);
});

test("momentumStep: dies below the stop velocity", () => {
  const s = momentumStep({ scrollTop: 100, velocity: 0.3, dtMs: 16.667, room: 400 });
  assert.equal(s.running, false);
  assert.equal(s.velocity, 0);
});

test("momentumStep: a flick near the end lands exactly on it", () => {
  // A capped flick covers ~350px; from 60 it crosses the end, which must
  // clamp it exactly, never past.
  let st = 60;
  let vel = FLICK_MAX_VELOCITY;
  let frames = 0;
  while (frames++ < 200) {
    const s = momentumStep({ scrollTop: st, velocity: vel, dtMs: 16.667, room: 400 });
    st = s.scrollTop;
    vel = s.velocity;
    assert.ok(st >= 0 && st <= 400, `scrollTop left its range: ${st}`);
    if (!s.running) break;
  }
  assert.equal(st, 400, "the flick must end exactly at the hard end");
});

test("momentumStep: a flick that dies mid-log stays in range", () => {
  // In a long log the same flick decays below the stop velocity before
  // reaching either end: it must simply stop, wherever that is, inside
  // the range -- there is no code path in which the log leaves it.
  let st = 400;
  let vel = FLICK_MAX_VELOCITY;
  let frames = 0;
  while (frames++ < 200) {
    const s = momentumStep({ scrollTop: st, velocity: vel, dtMs: 16.667, room: 800 });
    st = s.scrollTop;
    vel = s.velocity;
    assert.ok(st >= 0 && st <= 800, `scrollTop left its range: ${st}`);
    if (!s.running) break;
  }
  assert.ok(st > 400 && st < 800, `a mid-log death must stay mid-log: ${st}`);
});
