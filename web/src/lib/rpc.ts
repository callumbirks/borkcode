import type { RequestMethod, Requests, ServerEvent, ServerMessage } from "shared/protocol";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** WebSocket client for the borkcode server. Reconnects with backoff and reports connection state. */
export class RpcClient {
  #socket: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #retryDelay = 500;
  readonly #onEvent: (event: ServerEvent) => void;
  readonly #onConnection: (connected: boolean) => void;

  constructor(onEvent: (event: ServerEvent) => void, onConnection: (connected: boolean) => void) {
    this.#onEvent = onEvent;
    this.#onConnection = onConnection;
    this.#connect();
  }

  request<M extends RequestMethod>(
    method: M,
    params: Requests[M]["params"],
  ): Promise<Requests[M]["result"]> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to the borkcode server"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  #connect(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.#socket = socket;
    socket.onopen = () => {
      this.#retryDelay = 500;
      this.#onConnection(true);
    };
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data as string) as ServerMessage;
      if ("event" in data) {
        this.#onEvent(data.event);
        return;
      }
      const pending = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      if ("error" in data) pending?.reject(new Error(data.error.message));
      else pending?.resolve(data.result);
    };
    socket.onclose = () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("Connection lost"));
      this.#pending.clear();
      this.#onConnection(false);
      setTimeout(() => this.#connect(), this.#retryDelay);
      this.#retryDelay = Math.min(this.#retryDelay * 2, 5000);
    };
  }
}
