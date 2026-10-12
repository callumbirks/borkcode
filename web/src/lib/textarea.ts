/** Native textarea sizing also works in Safari, which lacks field-sizing. CSS caps its growth. */
export function resizeTextarea(element: HTMLTextAreaElement) {
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}
