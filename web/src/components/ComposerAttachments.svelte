<script lang="ts">
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import X from "@lucide/svelte/icons/x";
  import { pendingAttachments, removeAttachment } from "../lib/composerAttachments.svelte";

  let { threadId }: { threadId: string } = $props();

  const pending = $derived(pendingAttachments(threadId));
</script>

{#if pending.length > 0}
  <div class="strip">
    {#each pending as each (each.key)}
      <div
        class="thumb"
        class:failed={each.error}
        title={each.error ?? (each.attachment ? each.name : `Uploading ${each.name}…`)}
      >
        <img src={each.preview} alt={each.name} />
        {#if each.error}
          <span class="state"><CircleAlert size={16} /></span>
        {:else if !each.attachment}
          <span class="state progress" style:--progress={each.progress}></span>
        {/if}
        <button class="remove" title="Remove" onclick={() => removeAttachment(threadId, each.key)}>
          <X size={12} />
        </button>
      </div>
    {/each}
  </div>
  {#if pending.some((each) => each.error)}
    <p class="error">{pending.find((each) => each.error)?.error}. Remove it to send.</p>
  {/if}
{/if}

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  .thumb {
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    overflow: hidden;
    background: var(--surface-overlay);
  }
  .thumb.failed {
    border-color: var(--status-danger);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .state {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.5);
    color: var(--status-danger);
  }
  /* The unfilled part of the image dims; it repaints only when progress changes. */
  .progress {
    background: linear-gradient(to right, transparent calc(var(--progress) * 100%), rgb(0 0 0 / 0.6) 0);
  }
  .remove {
    position: absolute;
    top: 2px;
    right: 2px;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: var(--radius-full);
    background: rgb(0 0 0 / 0.65);
    color: white;
  }
  .error {
    margin: 0 0 var(--space-2);
    font-size: var(--text-xs);
  }
</style>
