export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Within this distance of the bottom, a downward scroll or a release re-pins. */
const NEAR_BOTTOM = 80;
/**
 * A scroll event this soon after input, or after another scroll the user made, is the user's:
 * momentum after a flick and animated wheel or key scrolling arrive as a chain of events.
 */
const GESTURE_GAP = 150;

const maxTop = (m: ScrollMetrics) => Math.max(0, m.scrollHeight - m.clientHeight);

/**
 * Keeps a transcript pinned to its bottom until the user scrolls up. Only the user unpins: the
 * browser also moves scrollTop on its own, clamping it when the range shrinks (the "Working…"
 * line going at a turn's end, the composer emptying, the keyboard closing) and anchoring or
 * re-measuring content above the view, and those scroll events can arrive before the
 * ResizeObserver callback that would have followed the change.
 *
 * Intent unpins before resizing can fight the gesture: holding the transcript (a finger, or the
 * mouse on it or its scrollbar) unpins at once, as does a wheel or key scrolling up, and upward
 * movement wins even within the bottom threshold, including momentum after the finger lifts.
 */
export class BottomPin {
  pinned = true;
  private last = 0;
  private holding = false;
  private movingUp = false;
  /** Pinned when the transcript was grabbed and nothing has scrolled since: a tap, not a drag. */
  private tapping = false;
  /** The transcript scrolled while held, so momentum may follow the release. */
  private dragged = false;
  private gestureUntil = -Infinity;

  reset() {
    this.pinned = true;
    this.last = 0;
    this.holding = false;
    this.movingUp = false;
    this.tapping = false;
    this.dragged = false;
    this.gestureUntil = -Infinity;
  }

  /** On any size change of the scroller or its content: the scrollTop to set, if pinned. */
  resized(m: ScrollMetrics): number | null {
    if (!this.pinned || this.holding) return null;
    return this.follow(m);
  }

  /** Pins and returns the scrollTop of the bottom, e.g. when the user sends a message. */
  follow(m: ScrollMetrics): number {
    this.pinned = true;
    this.movingUp = false;
    // Our own scroll's event arrives a frame later; it must not read as movement.
    this.last = maxTop(m);
    return this.last;
  }

  scrolled(m: ScrollMetrics, now: number) {
    const byUser = this.holding || now <= this.gestureUntil;
    if (byUser) this.gestureUntil = now + GESTURE_GAP;
    const top = Math.min(Math.max(m.scrollTop, 0), maxTop(m));
    if (top !== this.last) {
      this.tapping = false;
      if (this.holding) this.dragged = true;
    }
    if (top < this.last && byUser && maxTop(m) - top >= 1) {
      this.pinned = false;
      this.movingUp = true;
    } else {
      if (top > this.last) this.movingUp = false;
      if (!this.holding && maxTop(m) - top < NEAR_BOTTOM) this.pinned = true;
    }
    this.last = top;
  }

  /** Input that may scroll the transcript, such as a key. */
  input(now: number) {
    this.gestureUntil = now + GESTURE_GAP;
  }

  /** A finger on the transcript, or a mouse button pressed on it or its scrollbar. */
  hold() {
    this.holding = true;
    this.dragged = false;
    this.tapping = this.pinned;
    this.pinned = false;
  }

  /**
   * A tap, or a drag that ends at the bottom, scrolls no further, so no scroll event re-pins.
   * Content that streamed in under a tap doesn't count as leaving the bottom. A tap or click
   * scrolls nothing itself, so what moves after it (focus, layout) is not the user's.
   */
  release(m: ScrollMetrics, now: number) {
    if (!this.holding) return;
    this.holding = false;
    if (this.dragged) this.gestureUntil = now + GESTURE_GAP;
    if (this.tapping || (!this.movingUp && maxTop(m) - m.scrollTop < NEAR_BOTTOM)) this.pinned = true;
    this.tapping = false;
  }

  /** A wheel or key about to scroll up: unpin before any resize can pull the view back down. */
  intendUp(now: number) {
    this.input(now);
    this.pinned = false;
    this.movingUp = true;
  }
}
