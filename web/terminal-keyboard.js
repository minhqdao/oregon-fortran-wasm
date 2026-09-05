// @ts-check

// Pure decision helpers for the soft-keyboard contract, distilled from the
// keyboard-lab experiments (keyboard-lab/blue24.html is the accepted build;
// acceptance criteria in keyboard-lab/acceptance_criteria.md). The launcher
// owns the DOM wiring and the rAF loop; everything that can be decided from
// numbers alone lives here so it can be unit-tested without a browser.

/**
 * The iOS soft keyboard's slide duration, which the inset animation matches.
 * WebKit fires visualViewport.resize once, with the FINAL height, at the end
 * of that slide -- never progressively -- so waiting for the honest reading
 * means holding full size for the whole slide and snapping (the blue16
 * failure). The driver instead forecasts at focus and animates over this
 * window; the honest reading retargets the running move.
 */
export const KEYBOARD_SLIDE_MS = 250;

/**
 * A resize reading that argues AGAINST the running animation is trusted
 * once the slide is this far along, where WebKit's single end-of-slide
 * burst lands anyway. Earlier opposing readings are dropped: mid-slide
 * partials under-report, and acting on them produced blue18's
 * shrink-grow-shrink stutter. (Extending readings are trusted at any
 * phase -- partials only ever under-report mid-slide, so they cannot
 * overshoot.)
 */
export const LATE_READING_FRACTION = 0.65;

/**
 * At rest, a reading this far from the displayed inset triggers a short
 * glide; below it, the difference is transient noise not worth repainting.
 */
export const SETTLE_EPSILON_PX = 1.5;

/**
 * A mid-animation reading must disagree with the animation target by more
 * than this before it is worth retargeting. Filters out the few-pixel
 * wobble of toolbar transitions from real keyboard movement.
 */
export const MISMATCH_PX = 24;

/**
 * Southward drift up to this many px is the tremor at the top of a pull
 * (or a mostly-horizontal drag) and must never be gated, or Safari's
 * bounce and pull-to-refresh would feel broken at their threshold.
 */
export const DRAG_TREMOR_PX = 6;

/**
 * First-open forecast as a fraction of the layout height, used only until
 * one real keyboard height has been measured and stored. iOS soft
 * keyboards sit around 0.4 of a phone screen in portrait.
 */
export const EST_FRACTION = 0.42;

/**
 * localStorage key for the measured keyboard inset. Every open after the
 * very first forecasts the stored value exactly, so the common open runs
 * no end-of-slide correction at all.
 */
export const KEYBOARD_HEIGHT_KEY = "oregon.keyboardHeight";

/**
 * Ease-in-out curve the inset animation follows (the same shape blue24
 * used to match the keyboard's slide). Symmetric, monotonic, never
 * overshoots the target.
 * @param {number} t progress in [0, 1]
 * @returns {number} eased progress in [0, 1]
 */
export function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * The engine's response to the soft keyboard, decided from measurements
 * (never the UA): WebKit never resizes the layout viewport for the
 * keyboard and pans instead (bug 259770); engines honoring
 * interactive-widget=resizes-content shrink the layout itself.
 *
 * @typedef {"pan" | "resize" | "unknown"} KeyboardMode
 */

/**
 * Classify how the engine is reacting to a keyboard of `reading` px.
 * Only a reading that proves a keyboard is present (> 0.5px) can decide:
 * a WebKit that ever resizes the layout for the keyboard turns the pan
 * machinery (gate, scroll pinning) off by itself. A closed reading just
 * re-baselines the layout height for the next comparison.
 *
 * @param {{ reading: number, layoutHeight: number, baseLayoutHeight: number }} s
 * @returns {KeyboardMode}
 */
export function detectKeyboardMode({ reading, layoutHeight, baseLayoutHeight }) {
  if (reading <= 0.5) return "unknown";
  return layoutHeight < baseLayoutHeight - 4 ? "resize" : "pan";
}

/**
 * The inset to start animating toward at focus, before any honest reading
 * exists. Precedence: a measurement taken during THIS focus (the engine
 * may have already resized), else the stored height from a previous open,
 * else the fraction-of-layout estimate for a true first open.
 *
 * @param {{ measured: number, stored: number, layoutHeight: number, estFraction?: number }} s
 * @returns {number}
 */
export function forecastInset({ measured, stored, layoutHeight, estFraction = EST_FRACTION }) {
  if (measured > 0.5) return measured;
  if (stored > 0) return stored;
  return Math.round(layoutHeight * estFraction);
}

/**
 * What to do with an honest visualViewport reading while an open/close
 * animation may be running. This is the heart of "shrinks in sync"
 * (blue17's insight, blue20's symmetric retarget):
 *
 *   - "settle": the move is over; the caller glides to the reading when
 *     it differs from what is displayed, and does nothing otherwise.
 *   - "retarget": a reading that pushes the move further in its own
 *     direction is trusted at any phase (partials only under-report
 *     mid-slide) -- bend the running animation onto the honest target.
 *   - "retarget-late": a reading against the direction, trusted only
 *     once the slide is mostly over (see LATE_READING_FRACTION).
 *   - "drop": early opposing noise -- keep the current animation.
 *
 * @param {{
 *   settled: boolean,
 *   mismatch: boolean,
 *   extending: boolean,
 *   late: boolean,
 *   focused: boolean,
 * }} s
 * @returns {"settle" | "retarget" | "retarget-late" | "drop"}
 */
export function decideReading({ settled, mismatch, extending, late, focused }) {
  if (settled) return "settle";
  if (mismatch && (extending || (focused && late))) {
    return extending ? "retarget" : "retarget-late";
  }
  return "drop";
}

/**
 * Duration for a retarget: a move still running bends over its remaining
 * time (never restarts a full-duration one, which would stall the edge);
 * a move that already finished (or never ran) takes the short settle
 * glide. Mirrors the driveTo calls in blue24's onVvResize.
 *
 * @param {{ animating: boolean, animDur: number, elapsed: number, glideMs?: number }} s
 * @returns {number}
 */
export function retargetDuration({ animating, animDur, elapsed, glideMs = 120 }) {
  return animating ? Math.max(60, animDur - elapsed) : glideMs;
}

/**
 * Whether a northward drag should be preventDefault-ed -- the gate that
 * stops the whole page being dragged up into WebKit's keyboard pan slack
 * (blue5's failure, blue14/15's fix). Only a gesture can stop a gesture:
 * no height or overflow on html/body can remove that slack.
 *
 * Everything a user could legitimately be doing passes untouched:
 * southward drags and tremor (bounce, pull-to-refresh stay native),
 * multi-touch (pinch), and any open text selection (the magnifier and
 * selection handles stay native). A northward drag is blocked unless an
 * inner scroller under the finger can still consume it; an empty editable
 * never counts as consumable (its placeholder inflates scrollHeight, so
 * it could never surrender a drag otherwise).
 *
 * @param {{
 *   deltaY: number,
 *   multiTouch: boolean,
 *   selectionCollapsed: boolean,
 *   scroller: null | {
 *     scrollTop: number,
 *     scrollHeight: number,
 *     clientHeight: number,
 *     editable: boolean,
 *     value: string,
 *   },
 * }} s
 * @returns {boolean} true when the caller must preventDefault
 */
export function shouldBlockNorthDrag({ deltaY, multiTouch, selectionCollapsed, scroller }) {
  if (multiTouch) return false;
  if (deltaY > -DRAG_TREMOR_PX) return false;
  if (!selectionCollapsed) return false;
  if (!scroller) return true;
  const consumable =
    (!scroller.editable || scroller.value !== "") &&
    scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 1;
  return !consumable;
}
