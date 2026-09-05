// @ts-check

// Pure decision helpers for the transcript log driver, distilled from the
// keyboard-lab blue29/30/31 builds (blue31.html is the accepted build).
// blue29's answer to the transcript rubber band is to stop giving the log
// native scroll physics at all: #screen is overflow:hidden -- a
// non-scroller cannot stretch, cannot chain, and has no overscroll
// behavior to be overruled mid-gesture (blue26-28 shipped the evidence
// that WebKit decides a gesture's overscroll up front, so CSS at the edge
// cannot help a drag that ARRIVES there). All log movement is driven by
// the launcher's touch/wheel handlers writing scrollTop, clamped to
// [0, room] and rounded to whole pixels on every write -- the ends are
// hard BY CONSTRUCTION. What can be decided from numbers alone lives
// here so it can be unit-tested without a browser.

/**
 * How far past the top (px) a pull must reach before the gesture is
 * handed off to the page. Inside the zone the driver keeps writing the
 * hard 0 and preventDefault-ing, so a trembling finger can neither
 * flicker the page pull on and off nor flip between drive and hand-off.
 */
export const HANDOFF_DEAD_ZONE_PX = 6;

/** Momentum cap, px per 16.667ms frame. */
export const FLICK_MAX_VELOCITY = 48;

/** A slower release is a drag end, not a flick. */
export const FLICK_MIN_START_VELOCITY = 0.8;

/** Momentum dies once decayed below this, px per frame. */
export const FLICK_STOP_VELOCITY = 0.4;

/** Momentum decay per 16.667ms frame. */
export const FLICK_DECAY = 0.88;

/** Largest per-frame dt the decay accounts for, ms. */
export const FLICK_MAX_DT_MS = 48;

/**
 * Classify one touchmove over the transcript. Everything that is not the
 * log's scroll belongs to the page untouched ("page"): a latched hand-off
 * (the page owns the rest of the gesture, period -- blue30's fix for the
 * page pull fighting the log), a short log with nothing to scroll, an
 * open text selection (a selection drag, not a scroll), and above all a
 * southward pull that finds the log at its top -- nobody's scroll, so
 * never preventDefault-ed and the document at scroll 0 runs Safari's own
 * pull-to-refresh. "top" is a pull that ARRIVED at the top mid-gesture:
 * the driver writes the hard 0 and keeps preventDefault-ing inside the
 * dead zone; past the zone it hands the gesture to the page and LATCHES.
 * "drive" is an ordinary follow: the caller writes the clamped target and
 * preventDefaults so the page must not move.
 *
 * @param {{
 *   dy: number,
 *   top0: number,
 *   room: number,
 *   handOff: boolean,
 *   selectionCollapsed: boolean,
 *   handOffPx?: number,
 * }} s
 * @returns {{ action: "page" | "drive" } | { action: "top", latch: boolean }}
 */
export function decideLogMove({
  dy,
  top0,
  room,
  handOff,
  selectionCollapsed,
  handOffPx = HANDOFF_DEAD_ZONE_PX,
}) {
  if (handOff) return { action: "page" };
  if (room <= 1) return { action: "page" };
  if (!selectionCollapsed) return { action: "page" };
  if (dy > 0 && top0 <= 0) return { action: "page" };
  if (dy > 0 && top0 - dy <= 0) {
    return { action: "top", latch: top0 - dy <= -handOffPx };
  }
  return { action: "drive" };
}

/**
 * Release velocity for the emulated flick, px per 16.667ms frame, from
 * the driven scrollTop samples (kept: at most the last four). Native
 * momentum needs a scroller and the log has none, so the flick is
 * emulated from the last two samples. Returns 0 when there is nothing to
 * launch from (too few samples, a zero dt, or a release too slow to be a
 * flick).
 *
 * @param {Array<{ t: number, st: number }>} samples ascending in time
 * @param {{ cap?: number, min?: number }} [opts]
 * @returns {number}
 */
export function flickVelocity(
  samples,
  { cap = FLICK_MAX_VELOCITY, min = FLICK_MIN_START_VELOCITY } = {},
) {
  if (samples.length < 2) return 0;
  const a = samples[samples.length - 2];
  const b = samples[samples.length - 1];
  const dt = b.t - a.t;
  if (dt <= 0) return 0;
  const raw = ((b.st - a.st) / dt) * 16.667;
  const clamped = Math.max(-cap, Math.min(cap, raw));
  return Math.abs(clamped) < min ? 0 : clamped;
}

/**
 * One frame of the emulated momentum. Reads the CURRENT scrollTop (game
 * output may have re-pinned the log mid-flight), decays the velocity,
 * integrates, and stops hard: at either end the log cannot leave its
 * range -- there is no code path in which it does -- and below the stop
 * velocity the flick is over. The written scrollTop is a whole pixel:
 * subpixel writes shimmered the last few px before a stop (blue30).
 *
 * @param {{
 *   scrollTop: number,
 *   velocity: number,
 *   dtMs: number,
 *   room: number,
 *   decay?: number,
 *   stop?: number,
 *   maxDtMs?: number,
 * }} s
 * @returns {{ scrollTop: number, velocity: number, running: boolean }}
 */
export function momentumStep({
  scrollTop,
  velocity,
  dtMs,
  room,
  decay = FLICK_DECAY,
  stop = FLICK_STOP_VELOCITY,
  maxDtMs = FLICK_MAX_DT_MS,
}) {
  const dtFrames = Math.min(maxDtMs, Math.max(0, dtMs)) / 16.667;
  const v = velocity * Math.pow(decay, dtFrames);
  let st = scrollTop + v * dtFrames;
  let dead = false;
  if (st >= room) {
    st = room; // hard stop: the end
    dead = true;
  } else if (st <= 0) {
    st = 0; // hard stop: the top
    dead = true;
  } else if (Math.abs(v) < stop) {
    dead = true;
  }
  return { scrollTop: Math.round(st), velocity: dead ? 0 : v, running: !dead };
}

/**
 * The clamped, whole-pixel scrollTop a driven move writes. The ends are
 * hard by construction: no clamping bug anywhere in the gesture path can
 * push the text out of its range.
 *
 * @param {{ top0: number, dy: number, room: number }} s
 * @returns {number}
 */
export function drivenScrollTop({ top0, dy, room }) {
  return Math.round(Math.max(0, Math.min(room, top0 - dy)));
}

/** Wheel line-mode delta in CSS px per notch (deltaMode 1). */
export const WHEEL_LINE_PX = 16;

/**
 * One wheel event's effect on the log, and whether the event must be
 * preventDefault-ed. blue31's wheel contract: while the delta fits inside
 * the log it is consumed here (prevent = true, log scrolls, page stays);
 * once the delta would overshoot past an end, the log is clamped to the
 * edge and the event is NOT prevented (prevent = false) -- the browser
 * scrolls the outer page NATIVELY with the surplus, the same contract as
 * the touch hand-off at the top on iOS. Line/page delta modes are
 * converted to pixels (page-mode needs the page height) so the
 * overshoot decision is in one unit. The returned scrollTop is a whole
 * pixel, like every other write into the log.
 *
 * @param {{
 *   deltaY: number,
 *   deltaMode?: number,
 *   scrollTop: number,
 *   room: number,
 *   pageHeight?: number,
 * }} s
 * @returns {{ scrollTop: number, prevent: boolean }}
 */
export function decideLogWheel({
  deltaY,
  deltaMode = 0,
  scrollTop,
  room,
  pageHeight = 0,
}) {
  const dy =
    deltaMode === 1
      ? deltaY * WHEEL_LINE_PX
      : deltaMode === 2
        ? deltaY * pageHeight
        : deltaY;
  const target = scrollTop + dy;
  return {
    scrollTop: Math.round(Math.max(0, Math.min(room, target))),
    prevent: target >= 0 && target <= room,
  };
}
