// @ts-check

/**
 * Returns true while the browser has a non-collapsed text selection.
 * @param {Selection | null} selection
 */
export function hasTextSelection(selection) {
  return Boolean(selection && !selection.isCollapsed);
}

/**
 * Avoid replacing text nodes unnecessarily because doing so clears selections.
 * @param {Node} element
 * @param {string} text
 */
export function updateTextContent(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
