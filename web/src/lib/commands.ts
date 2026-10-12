import type { ProviderCommand } from "shared/protocol";

/**
 * The command name being typed: a `/` at the very start of the message, then non-whitespace up to
 * the caret. Providers run a command only when it opens the message, so nowhere else counts.
 */
export function commandAt(text: string, caret: number): { start: 0; query: string } | null {
  const match = /^\/(\S*)$/.exec(text.slice(0, caret));
  return match ? { start: 0, query: match[1] } : null;
}

/**
 * Commands matching the typed name, best first: name prefix, then a word in the name, then
 * anywhere in the name, then the description. Ties keep the provider's order.
 */
export function searchCommands(commands: ProviderCommand[], query: string): ProviderCommand[] {
  const needle = query.toLowerCase();
  const rank = (command: ProviderCommand) => {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.split(/[-_:]/).some((word) => word.startsWith(needle))) return 1;
    if (name.includes(needle)) return 2;
    if (command.description.toLowerCase().includes(needle)) return 3;
    return null;
  };
  return commands
    .map((command, index) => ({ command, index, rank: rank(command) }))
    .filter((entry): entry is typeof entry & { rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command);
}

/** Replaces the typed name, and any rest of that word, with the chosen command and a space. */
export function insertCommand(text: string, caret: number, name: string): { text: string; caret: number } {
  const end = caret + (/^\S*/.exec(text.slice(caret))?.[0].length ?? 0);
  const rest = text.slice(end).replace(/^ /, "");
  const head = `/${name} `;
  return { text: head + rest, caret: head.length };
}
