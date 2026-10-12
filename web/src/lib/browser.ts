/** Attachment queue keys need uniqueness, not cryptographic identity; IDs of saved files come from the server. */
export function uploadKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A version 4 UUID, for ids the server checks as UUIDs. `crypto.randomUUID` exists only in secure
 * contexts, which plain tailnet HTTP is not.
 */
export function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
