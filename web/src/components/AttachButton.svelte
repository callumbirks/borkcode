<script lang="ts">
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import { ACCEPTED_TYPES } from "../lib/attachments";
  import { attachFiles } from "../lib/composerAttachments.svelte";

  let { threadId }: { threadId: string } = $props();

  let input: HTMLInputElement | undefined = $state();

  function picked() {
    if (!input?.files) return;
    attachFiles(threadId, [...input.files]);
    input.value = "";
  }
</script>

<button class="ghost icon" title="Attach images (or paste or drop them)" onclick={() => input?.click()}>
  <Paperclip size={14} />
</button>
<input bind:this={input} type="file" accept={ACCEPTED_TYPES.join(",")} multiple hidden onchange={picked} />
