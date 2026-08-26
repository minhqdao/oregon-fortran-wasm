/** Returns true while the browser has a non-collapsed text selection. */
export function hasTextSelection(selection) {
  return Boolean(selection && !selection.isCollapsed);
}

/** Avoid replacing text nodes unnecessarily because doing so clears selections. */
export function updateTextContent(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
