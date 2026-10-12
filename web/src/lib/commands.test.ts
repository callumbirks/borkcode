import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderCommand } from "shared/protocol";
import { commandAt, insertCommand, searchCommands } from "./commands.ts";

const command = (name: string, description = ""): ProviderCommand => ({ name, description, argumentHint: "", firstMessage: true });
const commands = [command("usage", "Show plan usage"), command("compact", "Free up context"), command("context", "Show context usage")];

test("a / opens the menu only at the very start of the message", () => {
  assert.deepEqual(commandAt("/", 1), { start: 0, query: "" });
  assert.deepEqual(commandAt("/comp", 5), { start: 0, query: "comp" });
  assert.deepEqual(commandAt("/compact now", 3), { start: 0, query: "co" });
  assert.equal(commandAt("/compact now", 12), null);
  assert.equal(commandAt("see /compact", 12), null);
  assert.equal(commandAt("one\n/two", 8), null);
});

test("commands are ranked by name before description, keeping the provider's order", () => {
  assert.deepEqual(searchCommands(commands, "").map((c) => c.name), ["usage", "compact", "context"]);
  assert.deepEqual(searchCommands(commands, "co").map((c) => c.name), ["compact", "context"]);
  assert.deepEqual(searchCommands(commands, "CONT").map((c) => c.name), ["context", "compact"]);
  assert.deepEqual(searchCommands(commands, "usage").map((c) => c.name), ["usage", "context"]);
  assert.deepEqual(searchCommands(commands, "zzz"), []);
});

test("picking a command replaces the typed name with it and a space", () => {
  assert.deepEqual(insertCommand("/co", 3, "compact"), { text: "/compact ", caret: 9 });
  assert.deepEqual(insertCommand("/cox keep notes", 2, "compact"), { text: "/compact keep notes", caret: 9 });
});
