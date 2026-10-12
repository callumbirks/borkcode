export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Within this distance of the bottom, a downward scroll or a lifted finger re-pins. */
const NEAR_BOTTOM = 80;

const maxTop = (m: ScrollMetrics) => Math.max(0, m.scrollHeight - m.clientHeight);

/**
 * Keeps a transcript pinned to its bottom until the user scrolls up. Scroll intent unpins before
 * resizing can fight the gesture: a touch unpins at once, and upward movement wins even within
 * the bottom threshold, including momentum delivered after touchend.
 *
 * Positions are clamped to the scroll range: iOS rubber-banding past the bottom, and the browser
 * clamping scrollTop when the scroller grows (keyboard closing, composer shrinking after a send),
 * both look like upward movement otherwise and unpinned for good.
 */
export class BottomPin {
  pinned = true;
  private last = 0;
  private touching = false;
  private movingUp = false;
  /** Pinned when the finger went down and nothing has scrolled since: a tap, not a drag. */
  private tapping = false;

  reset() {
    this.pinned = true;
    this.last = 0;
    this.touching = false;
    this.movingUp = false;
    this.tapping = false;
  }

  /** On any size change of the scroller or its content: the scrollTop to set, if pinned. */
  resized(m: ScrollMetrics): number | null {
    if (!this.pinned || this.touching) return null;
    // Our own scroll's event arrives a frame later; it must not read as movement.
    this.last = maxTop(m);
    return this.last;
  }

  scrolled(m: ScrollMetrics) {
    const top = Math.min(Math.max(m.scrollTop, 0), maxTop(m));
    if (top !== this.last) this.tapping = false;
    if (top < this.last) {
      this.pinned = false;
      this.movingUp = true;
    } else {
      if (top > this.last) this.movingUp = false;
      if (!this.touching && maxTop(m) - top < NEAR_BOTTOM) this.pinned = true;
    }
    this.last = top;
  }

  touchStart() {
    this.touching = true;
    this.tapping = this.pinned;
    this.pinned = false;
  }

  /**
   * A tap, or a drag that ends at the bottom, scrolls no further, so no scroll event re-pins.
   * Content that streamed in under a tap doesn't count as leaving the bottom.
   */
  touchEnd(m: ScrollMetrics) {
    this.touching = false;
    if (this.tapping || (!this.movingUp && maxTop(m) - m.scrollTop < NEAR_BOTTOM)) this.pinned = true;
    this.tapping = false;
  }

  wheel(deltaY: number) {
    if (deltaY < 0) {
      this.pinned = false;
      this.movingUp = true;
    }
  }
}
