<script lang="ts">
  // Shown only while something is actually working: it animates every step, so don't leave it up.
  let { label = "Working" }: { label?: string } = $props();
  const frames = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];
</script>

<span class="spinner" role="status" aria-label={label} title={label}>
  <span class="frames" aria-hidden="true">
    {#each frames as frame (frame)}<span>{frame}</span>{/each}
  </span>
</span>

<style>
  /*
   * All frames sit in a strip behind a one-glyph window, and the strip steps sideways. Moving it
   * with `transform` runs on the compositor: stepping `content` instead repainted the page. Each
   * frame is clipped to its own cell, sized for fallback fonts' braille, which can be wider than
   * 1ch. Whole pixels keep each step sharp: a fractional one resamples the glyph. The window
   * uses `overflow: clip`, since `hidden` would move its baseline to its bottom edge.
   */
  .spinner {
    --cell: round(up, 0.75em, 1px);
    display: inline-block;
    width: var(--cell);
    overflow: clip;
    text-align: center;
    font-family: var(--font-mono);
    line-height: 1;
    color: var(--status-running);
  }
  .frames {
    display: flex;
    width: calc(10 * var(--cell));
    animation: braille 0.8s steps(10) infinite;
  }
  .frames > span {
    flex: none;
    width: var(--cell);
    overflow: clip;
    text-align: center;
  }
  @keyframes braille {
    to {
      transform: translateX(-100%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .frames {
      display: none;
    }
    .spinner::before {
      content: "⠿";
    }
  }
</style>
