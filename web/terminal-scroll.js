/** Scrolls the terminal viewport to its latest content. */
export function scrollTerminalToBottom(screen) {
  if (screen.scrollHeight > screen.clientHeight) {
    screen.scrollTop = screen.scrollHeight;
  }
}

/** Returns whether the terminal is already at its latest content. */
export function isTerminalScrolledToBottom(screen, tolerance = 2) {
  return (
    screen.scrollHeight - screen.clientHeight - screen.scrollTop <= tolerance
  );
}

/** Returns how far an active line extends below the visible viewport. */
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

/** Returns the terminal height that fits immediately above an obstruction. */
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
