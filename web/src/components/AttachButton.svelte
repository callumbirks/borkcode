<script lang="ts">
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import { attachFiles } from "../lib/composerAttachments.svelte";

  let { threadId }: { threadId: string } = $props();

  let input: HTMLInputElement | undefined = $state();

  function picked() {
    if (!input?.files) return;
    attachFiles(threadId, [...input.files]);
    input.value = "";
  }
</script>

<button class="ghost icon" title="Attach files (or paste or drop them)" onclick={() => input?.click()}>
  <Paperclip size={14} />
</button>
<!-- No `accept`, so phones offer files as well as the camera and photo library. -->
<input bind:this={input} type="file" multiple hidden onchange={picked} />
