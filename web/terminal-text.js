// @ts-check

// Pure text policy for submitted input lines. Everything upstream forwards
// faithfully: the hidden field keeps whatever the keyboard or IME produced
// (Vietnamese Telex "a"+"s" shows á, dead keys show their accented result,
// CJK shows its candidates) and the live echo mirrors it. Composed text
// REPLACES the character it accents, so any rewrite that dropped it deleted
// the base letter too -- the line-vanishes bug this module's choke point
// exists to avoid. The policy applies exactly once, in submitInput, where
// the one-byte-per-character engine buffer demands printable ASCII.

/**
 * Normalizes one submitted line to what the engine can store: upper case,
 * printable ASCII. Order matters -- upper case first so accents decompose
 * off their capital (á -> A, not a), then:
 *
 *   1. iOS Smart Punctuation's curly quotes map back to ASCII even with
 *      autocorrect off (keyboard-lab blue24), so contractions survive.
 *   2. Diacritics decompose (NFD) and their combining marks drop, so a
 *      dead-key or Telex keyboard yields the base letter instead of
 *      nothing: "wás" -> WAS, "loôk" -> LOOK. Vietnamese đ/Đ never
 *      decomposes (the stroke is part of the glyph), so it maps by hand.
 *   3. Anything still outside printable ASCII (CJK, emoji, symbols) drops.
 *
 * Length never grows for already upper-cased input: canonical (NFD)
 * decomposition is one base character plus marks, and every later step
 * only removes -- so a line capped at maxInputLength before this call
 * stays within the keys buffer after it.
 *
 * @param {string} line the live input text, any Unicode
 * @returns {string} the engine-safe line
 */
export function toEngineText(line) {
  return line
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .toUpperCase()
    .normalize("NFD")
    .replace(/\u0110/g, "D") // Đ's stroke is part of the glyph; NFD keeps it
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}
