/** What the browser reports: `visualViewport` metrics plus the layout viewport's size. */
export type ViewportSample = {
  /** visualViewport.height and offsetTop, in CSS pixels. */
  height: number;
  top: number;
  /** visualViewport.scale; pinch zoom shrinks `height` without a keyboard. */
  scale: number;
  /** The layout viewport, which position: fixed is relative to. */
  layoutWidth: number;
  layoutHeight: number;
};

export type ViewportLayout = {
  height: number;
  top: number;
  /** Distance from the visible bottom to the layout viewport's bottom, for bottom-anchored sheets. */
  bottom: number;
  keyboard: boolean;
};

/** More than any toolbar collapse, less than any on-screen keyboard. */
const KEYBOARD_MIN = 150;

/**
 * iOS never resizes the layout viewport for the keyboard (`interactive-widget` is ignored), so
 * 100dvh, innerHeight and vh keep the keyboard's height; Android with `resizes-content` shrinks
 * both. The keyboard is open when the visible height has dropped well below the tallest seen at
 * this width, which works either way. Width changes (rotation) start over.
 */
export function viewportTracker() {
  let width = 0;
  let tallest = 0;
  return (sample: ViewportSample): ViewportLayout => {
    const visible = sample.height * sample.scale;
    if (sample.layoutWidth !== width) {
      width = sample.layoutWidth;
      tallest = visible;
    }
    tallest = Math.max(tallest, visible);
    return {
      height: sample.height,
      top: sample.top,
      bottom: Math.max(0, sample.layoutHeight - sample.top - sample.height),
      keyboard: tallest - visible > KEYBOARD_MIN,
    };
  };
}
