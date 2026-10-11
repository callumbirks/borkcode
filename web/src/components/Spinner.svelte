<script lang="ts">
  // Shown only while something is actually working: it repaints every frame, so don't leave it up.
  let { label = "Working" }: { label?: string } = $props();
</script>

<span class="spinner" role="status" aria-label={label} title={label}></span>

<style>
  /* Stepping `content` keeps it pure CSS: no timer, and nothing runs once the element is gone. */
  .spinner::before {
    content: "⠋";
    animation: braille 0.8s steps(1, end) infinite;
  }
  .spinner {
    display: inline-block;
    font-family: var(--font-mono);
    line-height: 1;
    color: var(--status-running);
  }
  @keyframes braille {
    0% { content: "⠋"; }
    10% { content: "⠙"; }
    20% { content: "⠹"; }
    30% { content: "⠸"; }
    40% { content: "⠼"; }
    50% { content: "⠴"; }
    60% { content: "⠦"; }
    70% { content: "⠧"; }
    80% { content: "⠇"; }
    90% { content: "⠏"; }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner::before {
      content: "⠿";
      animation: none;
    }
  }
</style>
