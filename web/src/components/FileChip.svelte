<script lang="ts">
  import FileIcon from "@lucide/svelte/icons/file";
  import FileArchive from "@lucide/svelte/icons/file-archive";
  import FileCode from "@lucide/svelte/icons/file-code";
  import FileImage from "@lucide/svelte/icons/file-image";
  import FileMusic from "@lucide/svelte/icons/file-music";
  import FilePlay from "@lucide/svelte/icons/file-play";
  import FileSpreadsheet from "@lucide/svelte/icons/file-spreadsheet";
  import FileText from "@lucide/svelte/icons/file-text";
  import { fileKind, formatSize } from "../lib/attachments";

  /** A file that is not shown as an image: its icon by kind, name and size. */
  let { name, mimeType, size }: { name: string; mimeType: string; size: number } = $props();

  const icons = {
    image: FileImage,
    text: FileText,
    code: FileCode,
    data: FileSpreadsheet,
    archive: FileArchive,
    audio: FileMusic,
    video: FilePlay,
    other: FileIcon,
  };
  const Icon = $derived(icons[fileKind(name, mimeType)]);
</script>

<span class="file">
  <Icon size={18} />
  <span class="text">
    <span class="name">{name}</span>
    <span class="size">{formatSize(size)}</span>
  </span>
</span>

<style>
  .file {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    color: var(--text-secondary);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.3;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-size: var(--text-sm);
  }
  .size {
    font-size: var(--text-xs);
  }
</style>
