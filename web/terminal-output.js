/** Removes terminal control characters that browsers render as placeholder glyphs. */
export function sanitizeTerminalOutput(text) {
  return text.replaceAll("\u0007", "");
}
