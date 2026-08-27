import type { StreamHub } from './stream-hub.js';
import { STREAM_HEARTBEAT_MS } from './stream-session.js';

export interface StreamHeartbeatLoopOptions {
  readonly hub: StreamHub;
  readonly intervalMs?: number;
  readonly clock?: () => Date;
}

/** Exactly one timer per process drives heartbeats for every LIVE session (§7.6). */
export class StreamHeartbeatLoop {
  readonly intervalMs: number;
  readonly #hub: StreamHub;
  readonly #clock: () => Date;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StreamHeartbeatLoopOptions) {
    this.#hub = options.hub;
    this.intervalMs = options.intervalMs ?? STREAM_HEARTBEAT_MS;
    this.#clock = options.clock ?? (() => new Date());
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      this.#hub.heartbeat(this.#clock().toISOString());
    }, this.intervalMs);
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
