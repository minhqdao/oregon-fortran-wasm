// @ts-check

/**
 * Scrolls the terminal viewport to its latest content.
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} screen
 */
export function scrollTerminalToBottom(screen) {
  if (screen.scrollHeight > screen.clientHeight) {
    screen.scrollTop = screen.scrollHeight;
  }
}

/**
 * Whether the scrollable element is parked at the bottom (within a small
 * tolerance). Used to gate automatic re-scrolling so a reader who has
 * scrolled up to inspect history is never yanked back down by a layout
 * change that happens to coincide with their reading.
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} element
 */
export function isPinnedToBottom(element) {
  return element.scrollHeight - element.clientHeight - element.scrollTop < 2;
}

/**
 * How many layout-px of `anchor`'s bottom edge currently sit below the
 * visible area on a touch device: toolbars plus the soft keyboard, taken
 * together because the mobile layout sizes itself off the dynamic viewport
 * (dvh already tracks toolbars). The returned value lets the caller shrink
 * `anchor` by exactly that amount so the terminal's bottom -- where the
 * latest output and the input line live -- stays in view no matter how
 * much of the screen the keyboard covers.
 *
 * Geometric and self-correcting. `anchor` is assumed to be sized by a CSS
 * rule of the form `height: <base> - var(--keyboard-inset, 0px)`, so its
 * "natural" (inset-free) bottom in client coordinates is
 * `getBoundingClientRect().bottom + currentInset`. That value is compared
 * to the visible bottom in the same coordinate system
 * (`visualViewport.offsetTop + visualViewport.height`). The current inset
 * cancels out of the equation exactly when the height is linear in the
 * inset, so the result converges in a single measure and is stable across
 * subsequent calls -- there is no oscillation between "shrink" and "grow".
 *
 * Returns 0 when there is no `visualViewport` (the caller's fallback) or
 * while the page is pinch-zoomed (the zoom shrinks the visual viewport in
 * ways the layout should not chase, and the keyboard cannot be open
 * mid-pinch).
 *
 * @param {{ getBoundingClientRect: () => { bottom: number } }} anchor
 * @param {{ offsetTop: number, height: number, scale?: number } | null | undefined} viewport
 * @param {number} currentInset the inset currently applied to `anchor`
 *   (read from its `--keyboard-inset`); 0 if not yet measured.
 * @returns {number} pixels to apply as the new `--keyboard-inset` (>= 0)
 */
export function measureKeyboardInset(anchor, viewport, currentInset) {
  if (!viewport) return 0;
  if (viewport.scale && Math.abs(viewport.scale - 1) > 0.01) return 0;
  const rect = anchor.getBoundingClientRect();
  const visibleBottom = viewport.offsetTop + viewport.height;
  const naturalBottom = rect.bottom + currentInset;
  return Math.max(0, naturalBottom - visibleBottom);
}
