/**
 * Native textarea sizing also works in Safari, which lacks field-sizing. CSS caps its growth and
 * a full phone composer shrinks it, so it scrolls inside; collapsing it to measure resets that
 * scroll, so typing at the end keeps the caret in view.
 */
export function resizeTextarea(element: HTMLTextAreaElement) {
  const scrollTop = element.scrollTop;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
  element.scrollTop = element.selectionEnd === element.value.length ? element.scrollHeight : scrollTop;
}
