// Provider slash commands run only when they open the message, so a message that starts with one
// goes to the agent alone and as typed.

/** The command a message starts with, such as "compact" for "/compact keep the API notes", else null. */
export function commandName(text: string): string | null {
  return /^\/([a-z][\w:-]*)(?:\s|$)/i.exec(text.trimStart())?.[1]?.toLowerCase() ?? null;
}
