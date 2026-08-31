// @ts-check

/**
 * Keeps append-only terminal input editing at the end of the native field.
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
