<script lang="ts">
  import { chipBeside, coverReferences, History, replaceRange, type Snapshot } from "../lib/composerModel";
  import { findFileReferences, splitReferences, type ReferenceRoots } from "../lib/fileReferences";

  // The composer's text box. A textarea can't show file references as chips, so this is a
  // contenteditable whose text stays the source of truth: every edit arrives as `beforeinput`, is
  // applied to the text, and the box is redrawn from it. IME composition is the exception; the
  // browser edits the DOM and the text is read back when it ends.
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
    const nodes: Node[] = splitReferences(text, references(text)).map((part) => {
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
    if (node.dataset.sentinel !== undefined) return 0;
    return serialize(node).length;
  }

  /** Reads text back from the DOM, after the browser edited it during composition. */
  function serialize(root: Node): string {
    let out = "";
    root.childNodes.forEach((node, index) => {
      if (node instanceof Text) out += node.data;
      else if (node instanceof HTMLElement && node.dataset.source !== undefined) out += node.dataset.source;
      else if (node instanceof HTMLBRElement) out += node.dataset.sentinel !== undefined ? "" : "\n";
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
    return [root, last instanceof HTMLElement && last.dataset.sentinel !== undefined ? children.length - 1 : children.length];
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
    history.record(here(), kind, Date.now());
    commit(next);
  }

  function commit(next: Snapshot) {
    text = next.text;
    onchange(text);
    render(next.caret);
  }

  function onBeforeInput(event: InputEvent) {
    if (composing || event.isComposing || event.inputType.includes("Composition")) return;
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
      typingAt = typed ? start + 1 : null;
      apply(replaceRange(text, start, end, insert), typed ? "typing" : type);
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
    history.record(here(), "compose", Date.now());
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
    oninput={readBack}
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
  .input {
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
    inset: 0 0 auto;
    color: var(--text-faint);
    font-size: var(--text-md);
    pointer-events: none;
  }
</style>
