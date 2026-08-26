/** Keeps append-only terminal input editing at the end of the native field. */
export function moveInputCaretToEnd(input) {
  const end = input.value.length;
  input.setSelectionRange?.(end, end);
}

/** Touch needs an earlier focus gesture than the synthetic click on mobile. */
export function isTouchPointer(event) {
  return event.pointerType === "touch";
}
