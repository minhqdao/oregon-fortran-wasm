/** Removes terminal control characters that browsers render as placeholder glyphs. */
export function sanitizeTerminalOutput(text) {
  return text.replaceAll("\u0007", "");
}

/**
 * The FORTRAN source prints nearly every line with a leading blank (the 1X
 * format specifier, a teletype-era convention). Stripping one leading space
 * per line aligns the game output with user input at column 0 while deeper
 * intentional indentation (3X, 10X, ...) is preserved relative to it.
 * `atLineStart` must say whether `text` begins at the start of a line in the
 * rendered transcript; the caller derives it from the transcript because
 * echoed user input is interleaved with the game output.
 */
export function stripLineLeadingSpace(text, atLineStart) {
  return text
    .split("\n")
    .map((line, index) =>
      (index > 0 || atLineStart) && line.startsWith(" ")
        ? line.slice(1)
        : line,
    )
    .join("\n");
}
