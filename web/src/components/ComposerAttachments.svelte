<script lang="ts">
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import X from "@lucide/svelte/icons/x";
  import { pendingAttachments, removeAttachment } from "../lib/composerAttachments.svelte";
  import FileChip from "./FileChip.svelte";

  let { draftKey }: { draftKey: string } = $props();

  const pending = $derived(pendingAttachments(draftKey));
</script>

{#if pending.length > 0}
  <div class="strip">
    {#each pending as each (each.key)}
      <div
        class={each.preview ? "thumb" : "chip"}
        class:failed={each.error}
        title={each.error ?? (each.attachment ? each.name : `Uploading ${each.name}…`)}
      >
        {#if each.preview}
          <img src={each.preview} alt={each.name} />
        {:else}
          <FileChip name={each.name} mimeType={each.mimeType} size={each.size} />
        {/if}
        {#if each.error}
          <span class="state"><CircleAlert size={16} /></span>
        {:else if !each.attachment}
          <span class="state progress" style:--progress={each.progress}></span>
        {/if}
        <button class="remove" title="Remove {each.name}" onclick={() => removeAttachment(draftKey, each.key)}>
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
  .thumb,
  .chip {
    position: relative;
    height: 56px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    overflow: hidden;
    background: var(--surface-overlay);
  }
  .thumb {
    width: 56px;
  }
  /* Room on the right for the remove button. */
  .chip {
    display: flex;
    align-items: center;
    max-width: min(240px, 100%);
    padding: 0 var(--space-6) 0 var(--space-3);
  }
  /* Touch layouts make the remove button a taller, wider target. */
  @media (pointer: coarse), (max-width: 900px) {
    .chip {
      padding-right: var(--space-8);
    }
  }
  .failed {
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
  /* The unfilled part dims; it repaints only when progress changes. */
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
