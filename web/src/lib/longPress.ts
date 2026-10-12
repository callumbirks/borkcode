/**
 * Pressing and holding a touch opens what a right-click would. iOS Safari never sends
 * `contextmenu` for a touch, so this times the press itself. Moving the finger, as when
 * scrolling the list, cancels it; lifting early leaves it an ordinary tap.
 */
export class LongPress {
  readonly #onPress: (x: number, y: number) => void;
  readonly #schedule: (run: () => void, delay: number) => unknown;
  readonly #unschedule: (timer: unknown) => void;
  #timer: unknown;
  #origin = { x: 0, y: 0 };
  #fired = false;

  constructor(
    onPress: (x: number, y: number) => void,
    schedule: (run: () => void, delay: number) => unknown = setTimeout,
    unschedule: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  ) {
    this.#onPress = onPress;
    this.#schedule = schedule;
    this.#unschedule = unschedule;
  }

  start(x: number, y: number): void {
    this.cancel();
    this.#fired = false;
    this.#origin = { x, y };
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      this.#fired = true;
      this.#onPress(x, y);
    }, 500);
  }

  move(x: number, y: number): void {
    if (Math.hypot(x - this.#origin.x, y - this.#origin.y) > 10) this.cancel();
  }

  /** Whether the press opened something, in which case the tap's click should be swallowed. */
  end(): boolean {
    this.cancel();
    return this.#fired;
  }

  cancel(): void {
    if (this.#timer !== undefined) this.#unschedule(this.#timer);
    this.#timer = undefined;
  }
}

/** An attachment calling `onPress` with the touch's position when the element is long-pressed. */
export function longPress(onPress: (x: number, y: number) => void) {
  return (node: HTMLElement) => {
    const press = new LongPress(onPress);
    const start = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length === 1 && touch) press.start(touch.clientX, touch.clientY);
      else press.cancel();
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch) press.move(touch.clientX, touch.clientY);
    };
    // Cancelling touchend stops the click that would otherwise follow the press.
    const end = (event: TouchEvent) => {
      if (press.end()) event.preventDefault();
    };
    const cancel = () => press.cancel();
    node.addEventListener("touchstart", start, { passive: true });
    node.addEventListener("touchmove", move, { passive: true });
    node.addEventListener("touchend", end);
    node.addEventListener("touchcancel", cancel);
    return () => {
      press.cancel();
      node.removeEventListener("touchstart", start);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", cancel);
    };
  };
}
