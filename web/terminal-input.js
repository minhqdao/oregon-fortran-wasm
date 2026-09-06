// @ts-check

/**
 * Keeps append-only terminal input editing at the end of the native field.
 * The caller must not invoke this while an IME composition is active: the
 * IME owns the selection while its text is marked, and a selection write
 * under it corrupts the marked range -- every composition update then
 * re-inserts its full pending text instead of replacing it.
 * @param {HTMLInputElement} input
 */
export function moveInputCaretToEnd(input) {
  const end = input.value.length;
  input.setSelectionRange?.(end, end);
}

/**
 * Mobile browsers synthesize mouse and click events after a touch, but
 * suppress the click whenever the finger moved (scroll drag, selection pan);
 * a click that follows a touch is therefore a released tap. The desktop click
 * path must not fire the same activation twice.
 * @param {{ pointerType?: string }} event
 */
export function isTouchPointer(event) {
  return event.pointerType === "touch";
}
