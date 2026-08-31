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
 * Returns whether the terminal is already at its latest content.
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} screen
 * @param {number} [tolerance]
 */
export function isTerminalScrolledToBottom(screen, tolerance = 2) {
  return (
    screen.scrollHeight - screen.clientHeight - screen.scrollTop <= tolerance
  );
}

/**
 * Returns how far an active line extends below the visible viewport.
 * @param {Element} activeLine
 * @param {number} visibleBottom
 * @param {number} [padding]
 */
export function terminalActiveLineOverlap(
  activeLine,
  visibleBottom,
  padding = 8,
) {
  return Math.max(
    0,
    activeLine.getBoundingClientRect().bottom + padding - visibleBottom,
  );
}

/**
 * Returns the terminal height that fits immediately above an obstruction.
 * @param {Element} terminal
 * @param {number} visibleBottom
 * @param {number} [padding]
 */
export function terminalHeightAboveViewport(
  terminal,
  visibleBottom,
  padding = 8,
) {
  return Math.max(
    1,
    Math.floor(visibleBottom - terminal.getBoundingClientRect().top - padding),
  );
}
