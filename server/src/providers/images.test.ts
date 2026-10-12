import assert from "node:assert/strict";
import { test } from "node:test";
import { viewedImage } from "./claude.ts";
import { toItem } from "./codex.ts";

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };

test("Claude's Read of an image names the file it showed", () => {
  assert.equal(viewedImage("Read", { file_path: "/ws/app/shot.png" }, [image]), "/ws/app/shot.png");
  assert.equal(viewedImage("Read", { file_path: "/ws/app/a.ts" }, [{ type: "text", text: "1\tx" }]), undefined);
  assert.equal(viewedImage("Read", { file_path: "/ws/app/a.ts" }, "text"), undefined);
  // Screenshots from MCP tools have no file to point at.
  assert.equal(viewedImage("mcp__browser__screenshot", { file_path: "/x.png" }, [image]), undefined);
});

test("Codex's image views become tool items with the image's path", () => {
  assert.deepEqual(toItem({ type: "imageView", id: "v1", path: "/ws/app/shot.png" }), {
    id: "v1",
    kind: "tool",
    name: "view image",
    summary: "/ws/app/shot.png",
    output: null,
    status: "done",
    image: "/ws/app/shot.png",
  });
});
