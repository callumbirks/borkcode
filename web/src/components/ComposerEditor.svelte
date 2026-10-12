<script lang="ts">
  import { chipBeside, coverReferences, History, insertBeside, replaceRange, sameChips, type Snapshot } from "../lib/composerModel";
  import { findFileReferences, splitReferences, type FileReference, type ReferenceRoots } from "../lib/fileReferences";

  // The composer's text box. A textarea can't show file references as chips, so this is a
  // contenteditable whose text stays the source of truth. Plain typing and deleting inside one
  // text node is left to the browser and read back from that node, since redrawing on every key
  // made typing lag. Edits that touch a chip, newlines, paste and the like arrive as `beforeinput`,
  // are applied to the text, and the box is redrawn from it. IME composition edits the DOM and is
  // read back when it ends.
  let {
    value,
    roots,
    placeholder,
    onchange,
    onkeydown,
    onpaste,
  }: {
    value: string;
    roots: ReferenceRoots | null;
    placeholder: string;
    onchange: (text: string) => void;
    onkeydown: (event: KeyboardEvent) => void;
    onpaste: (event: ClipboardEvent) => void;
  } = $props();

  let element = $state<HTMLDivElement>();
  let text = "";
  /** Where the last typed character ended; a reference still being typed there stays plain text. */
  let typingAt: number | null = null;
  let composing = $state(false);
  const history = new History();
  /** The chips on screen, to tell whether a native edit changed which references are chips. */
  let shown: FileReference[] = [];
  /** An edit left to the browser, inside `node`, which starts at `at` in the text. */
  let native: { node: Text; at: number; length: number; before: Snapshot; kind: string } | null = null;

  function references(of: string) {
    if (!roots) return [];
    return findFileReferences(of, roots).filter((reference) => reference.end !== typingAt);
  }

  $effect(() => {
    // Drafts change from outside too: switching threads, sending, answering a question.
    if (value === text || composing) return;
    text = value;
    typingAt = null;
    history.clear();
    render(document.activeElement === element ? text.length : null);
  });

  $effect(() => {
    void roots;
    if (composing) return;
    render(document.activeElement === element ? (selected()?.[1] ?? null) : null);
  });

  function render(caretAt: number | null) {
    if (!element) return;
    shown = references(text);
    const nodes: Node[] = splitReferences(text, shown).map((part) => {
      if (!part.reference) return document.createTextNode(part.text);
      const chip = document.createElement("span");
      chip.className = "file-chip";
      chip.contentEditable = "false";
      chip.dataset.source = part.text;
      chip.title = part.reference.label;
      chip.textContent = part.reference.name;
      return chip;
    });
    // Without it a trailing newline has no line to put the caret on.
    if (text.endsWith("\n")) nodes.push(sentinel());
    element.replaceChildren(...nodes);
    if (caretAt !== null) select(caretAt, caretAt);
  }

  function sentinel() {
    const br = document.createElement("br");
    br.dataset.sentinel = "";
    return br;
  }

  function lengthOf(node: Node): number {
    if (node instanceof Text) return node.data.length;
    if (!(node instanceof HTMLElement)) return 0;
    if (node.dataset.source !== undefined) return node.dataset.source.length;
    if (node instanceof HTMLBRElement) return 0;
    return serialize(node).length;
  }

  /** Reads text back from the DOM, after the browser edited it during composition. */
  function serialize(root: Node): string {
    let out = "";
    root.childNodes.forEach((node, index) => {
      if (node instanceof Text) out += node.data;
      else if (node instanceof HTMLElement && node.dataset.source !== undefined) out += node.dataset.source;
      // Newlines are always text here; a <br> is the sentinel or the placeholder a browser puts in an
      // emptied box.
      else if (node instanceof HTMLBRElement) out += "";
      else if (node instanceof HTMLElement) out += (index > 0 ? "\n" : "") + serialize(node);
    });
    return out;
  }

  /** A DOM position as an offset in the text. Positions inside a chip snap to its start. */
  function offsetOf(node: Node, offset: number): number {
    if (!element) return 0;
    const children = [...element.childNodes];
    if (node === element) return children.slice(0, offset).reduce((sum, child) => sum + lengthOf(child), 0);
    let total = 0;
    for (const child of children) {
      if (child === node) return total + (child instanceof Text ? offset : offset > 0 ? lengthOf(child) : 0);
      if (child.contains(node)) {
        if (child instanceof HTMLElement && child.dataset.source !== undefined) return total;
        return total + Math.min(offset, lengthOf(child));
      }
      total += lengthOf(child);
    }
    return total;
  }

  function pointAt(offset: number): [Node, number] {
    const root = element!;
    let total = 0;
    const children = [...root.childNodes];
    for (const [index, child] of children.entries()) {
      const length = lengthOf(child);
      // After a final newline, the caret belongs on the next line, before the sentinel.
      const atNewline = offset === total + length && index < children.length - 1;
      if (child instanceof Text && offset <= total + length && !(atNewline && child.data.endsWith("\n"))) {
        return [child, offset - total];
      }
      if (offset <= total) return [root, index];
      total += length;
    }
    const last = children.at(-1);
    return [root, last instanceof HTMLBRElement ? children.length - 1 : children.length];
  }

  function select(start: number, end: number) {
    const selection = window.getSelection();
    if (!selection || !element) return;
    const range = document.createRange();
    range.setStart(...pointAt(start));
    range.setEnd(...pointAt(end));
    selection.removeAllRanges();
    selection.addRange(range);
    const box = range.getBoundingClientRect();
    const view = element.getBoundingClientRect();
    if (box.height > 0 && box.bottom > view.bottom) element.scrollTop += box.bottom - view.bottom;
    if (box.height > 0 && box.top < view.top) element.scrollTop -= view.top - box.top;
  }

  function selected(): [number, number] | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !element) return null;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) return null;
    return [offsetOf(range.startContainer, range.startOffset), offsetOf(range.endContainer, range.endOffset)];
  }

  /** Where the caret was, for undo to return to; the end of a selection. */
  function here(): Snapshot {
    return { text, caret: selected()?.[1] ?? text.length };
  }

  function apply(next: Snapshot, kind: string) {
    history.record(here(), next, kind, Date.now());
    commit(next);
  }

  function commit(next: Snapshot) {
    text = next.text;
    onchange(text);
    render(next.caret);
  }

  /**
   * Plain typing or deleting within one text node, away from any chip, which the browser can do
   * itself. Returns the edit to read back on `input`, or null to handle it here.
   */
  function nativeEdit(event: InputEvent): typeof native {
    const type = event.inputType;
    const data = event.data ?? "";
    const typing = type === "insertText" && data !== "" && !data.includes("\n");
    if (!typing && !/^delete(Content|Word)(Backward|Forward)$/.test(type)) return null;
    const selection = window.getSelection();
    const range = event.getTargetRanges()[0] ?? (selection?.rangeCount ? selection.getRangeAt(0) : null);
    const node = range?.startContainer;
    if (!range || !(node instanceof Text) || range.endContainer !== node || node.parentNode !== element) return null;
    const at = offsetOf(node, 0);
    const [start, end] = [at + range.startOffset, at + range.endOffset];
    if (typing) {
      // Typing against a chip needs a space added, so it goes through `insertBeside`.
      if (insertBeside(text, start, end, data, shown).text !== replaceRange(text, start, end, data).text) return null;
    } else if (start === end || (start === at && end === at + node.data.length)) {
      // An emptied text node is removed and replaced by the browser's own placeholder.
      return null;
    }
    return { node, at, length: node.data.length, before: here(), kind: typing && data.length === 1 ? "typing" : type };
  }

  /** Takes in an edit the browser made: usually just the text, sometimes the chips change too. */
  function onInput() {
    const edit = native;
    native = null;
    if (!edit || edit.node.parentNode !== element) {
      readBack();
      if (edit) history.record(edit.before, { text, caret: caret() }, edit.kind, Date.now());
      return;
    }
    const next = text.slice(0, edit.at) + edit.node.data + text.slice(edit.at + edit.length);
    const caretAt = caret();
    history.record(edit.before, { text: next, caret: caretAt }, edit.kind, Date.now());
    typingAt = edit.kind === "typing" ? caretAt : null;
    text = next;
    onchange(text);
    const wanted = references(text);
    const same =
      sameChips(shown, wanted, edit.at, edit.length, edit.node.data.length) &&
      (element?.lastChild instanceof HTMLBRElement) === text.endsWith("\n");
    if (same) shown = wanted;
    else render(caretAt < 0 ? text.length : caretAt);
  }

  function onBeforeInput(event: InputEvent) {
    if (composing || event.isComposing || event.inputType.includes("Composition")) return;
    native = nativeEdit(event);
    if (native) return;
    event.preventDefault();
    const type = event.inputType;
    if (type === "historyUndo") return undo();
    if (type === "historyRedo") return redo();
    const target = event.getTargetRanges()[0];
    let [start, end] = target
      ? [offsetOf(target.startContainer, target.startOffset), offsetOf(target.endContainer, target.endOffset)]
      : (selected() ?? [text.length, text.length]);
    const refs = references(text);
    if (type.startsWith("insert")) {
      const insert =
        type === "insertLineBreak" || type === "insertParagraph"
          ? "\n"
          : (event.data ?? event.dataTransfer?.getData("text/plain") ?? "");
      [start, end] = coverReferences(start, end, refs);
      const typed = type === "insertText" && insert.length === 1;
      const next = insertBeside(text, start, end, insert, refs);
      typingAt = typed ? next.caret : null;
      apply(next, typed ? "typing" : type);
    } else if (type.startsWith("delete") && type !== "deleteByDrag") {
      const current = selected();
      const collapsed = current && current[0] === current[1];
      const chip = collapsed && type.startsWith("deleteContent") ? chipBeside(current[0], type.endsWith("Backward"), refs) : null;
      [start, end] = chip ?? coverReferences(start, end, refs);
      if (start === end) return;
      typingAt = null;
      apply(replaceRange(text, start, end, ""), type);
    }
  }

  function undo() {
    const previous = history.undo(here());
    typingAt = null;
    if (previous) commit(previous);
  }

  function redo() {
    const next = history.redo(here());
    typingAt = null;
    if (next) commit(next);
  }

  function onKeydown(event: KeyboardEvent) {
    onkeydown(event);
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) undo();
    else if ((key === "z" && event.shiftKey) || key === "y") redo();
    else return;
    event.preventDefault();
  }

  /** Copies the references themselves, not the file names the chips show. */
  function onCopy(event: ClipboardEvent) {
    const range = selected();
    if (!range || range[0] === range[1]) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text.slice(range[0], range[1]));
    if (event.type === "cut") {
      typingAt = null;
      apply(replaceRange(text, range[0], range[1], ""), "cut");
    }
  }

  function onCompositionStart() {
    history.record(here(), here(), "compose", Date.now());
    composing = true;
  }

  function readBack() {
    if (!element || composing) return;
    const next = serialize(element);
    const at = caret();
    typingAt = null;
    if (next !== text) {
      text = next;
      onchange(text);
    }
    render(at < 0 ? text.length : at);
  }

  /** The caret's offset in the text, or -1 when a range is selected or the box isn't focused. */
  export function caret(): number {
    const range = selected();
    return range && range[0] === range[1] ? range[0] : -1;
  }

  export function node(): HTMLElement | undefined {
    return element;
  }

  /** Replaces the whole text as one undoable step, as the mention picker does. */
  export function setText(next: string, caretAt: number) {
    element?.focus();
    typingAt = null;
    apply({ text: next, caret: caretAt }, "replace");
  }
</script>

<div class="editor">
  {#if !value && !composing}<div class="placeholder">{placeholder}</div>{/if}
  <div
    bind:this={element}
    class="input"
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-placeholder={placeholder}
    data-composer
    onbeforeinput={onBeforeInput}
    oninput={onInput}
    onkeydown={onKeydown}
    {onpaste}
    oncopy={onCopy}
    oncut={onCopy}
    oncompositionstart={onCompositionStart}
    oncompositionend={() => {
      composing = false;
      readBack();
    }}
  ></div>
</div>

<style>
  .editor {
    position: relative;
  }
  /*
   * Its own compositor layer, so a keystroke re-rasters only this box rather than tiles spanning
   * the page. The layer must be opaque to keep subpixel text, so its background has to match the
   * composer's surface around it.
   */
  .input {
    transform: translateZ(0);
    background: var(--surface-raised);
    min-height: 44px;
    max-height: 240px;
    overflow-y: auto;
    outline: none;
    font-size: var(--text-md);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .placeholder {
    position: absolute;
    z-index: 1;
    inset: 0 0 auto;
    color: var(--text-faint);
    font-size: var(--text-md);
    pointer-events: none;
  }
</style>
