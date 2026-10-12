/** Attachment queue keys need uniqueness, not cryptographic identity; IDs of saved files come from the server. */
export function uploadKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The paste event and the selected-text copy command also work outside secure contexts. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try selected-text copy. */ }
  }
  const focused = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  field.readOnly = true;
  document.body.append(field);
  field.select();
  field.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  field.remove();
  if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  if (!copied) throw new Error("Copy isn't available in this browser; select and copy the text instead.");
}
