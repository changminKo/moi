import type { MetricsRegistry } from '../../observability/metrics.js';
import type {
  DurableAccountEvent,
  QuoteEvent,
  StreamOpenResult,
  StreamSession,
  StreamSocket,
} from './stream-session.js';

export const STREAM_OPENING_QUEUE_MAX = 200;
export const STREAM_PROMOTE_MAX_ROUNDS = 20;

export type StreamEntryState = 'OPENING' | 'LIVE';
export type StreamHandle = { readonly id: number; readonly sessionId: string };

type LogFn = (event: string, fields: Record<string, unknown>) => void;

interface Entry {
  readonly handle: StreamHandle;
  readonly ws: StreamSocket;
  state: StreamEntryState;
  queue: DurableAccountEvent[];
  session?: StreamSession;
  depthAtLive?: number;
}

export interface StreamHubDeps {
  readonly metrics?: MetricsRegistry;
  readonly log?: LogFn;
}

function bySequence(a: DurableAccountEvent, b: DurableAccountEvent): number {
  const x = BigInt(a.accountSequence);
  const y = BigInt(b.accountSequence);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * In-process registry of user-stream sessions (§7.5). A session is registered
 * as OPENING *before* the durable `latest`/`replay` read so live events
 * published during replay are queued rather than lost; `promoteToLive`
 * flushes the queue in rounds and flips to LIVE only inside the synchronous
 * section that observed an empty queue.
 */
export class StreamHub {
  readonly #entries = new Map<string, Set<Entry>>();
  readonly #byHandle = new Map<number, Entry>();
  readonly #deps: StreamHubDeps;
  #nextId = 1;

  constructor(deps: StreamHubDeps = {}) {
    this.#deps = deps;
  }

  registerOpening(sessionId: string, ws: StreamSocket): StreamHandle {
    const handle: StreamHandle = { id: this.#nextId++, sessionId };
    const entry: Entry = { handle, ws, state: 'OPENING', queue: [] };
    const set = this.#entries.get(sessionId) ?? new Set<Entry>();
    set.add(entry);
    this.#entries.set(sessionId, set);
    this.#byHandle.set(handle.id, entry);
    return handle;
  }

  unregister(sessionId: string, handle: StreamHandle): void {
    const entry = this.#byHandle.get(handle.id);
    if (entry === undefined) return;
    this.#byHandle.delete(handle.id);
    entry.queue = [];
    const set = this.#entries.get(sessionId);
    set?.delete(entry);
    if (set !== undefined && set.size === 0) this.#entries.delete(sessionId);
  }

  async deliver(sessionId: string, event: DurableAccountEvent): Promise<void> {
    const set = this.#entries.get(sessionId);
    if (set === undefined) return;
    for (const entry of [...set]) {
      if (entry.state === 'LIVE') {
        await entry.session?.deliver(event);
        continue;
      }
      if (entry.queue.length < STREAM_OPENING_QUEUE_MAX) {
        entry.queue.push(event);
        continue;
      }
      this.#overflow(entry);
    }
  }

  async promoteToLive(
    sessionId: string,
    handle: StreamHandle,
    opened: StreamOpenResult,
  ): Promise<boolean> {
    const flushed = new Set<string>();
    const replayedUpTo = BigInt(opened.replayedUpTo);
    let rounds = 0;
    for (;;) {
      const entry = this.#byHandle.get(handle.id);
      if (entry === undefined || entry.state !== 'OPENING') return false;
      if (entry.queue.length === 0) {
        entry.depthAtLive = entry.queue.length;
        entry.session = opened.session;
        entry.state = 'LIVE';
        return true;
      }
      const batch = entry.queue;
      entry.queue = [];
      const ordered = [...batch]
        .sort(bySequence)
        .filter(
          (e) =>
            BigInt(e.accountSequence) > replayedUpTo &&
            !opened.replayedEventIds.has(e.eventId) &&
            !flushed.has(e.eventId),
        );
      for (const event of ordered) {
        flushed.add(event.eventId);
        await opened.session.deliver(event);
      }
      rounds += 1;
      if (rounds > STREAM_PROMOTE_MAX_ROUNDS) {
        const current = this.#byHandle.get(handle.id);
        if (current !== undefined) this.#overflow(current);
        return false;
      }
    }
    void sessionId;
  }

  publishQuote(event: QuoteEvent): void {
    for (const entry of this.#byHandle.values())
      if (entry.state === 'LIVE') entry.session?.publishQuote(event);
  }

  heartbeat(serverTime: string): void {
    let depth = 0;
    for (const entry of this.#byHandle.values()) {
      if (entry.state === 'LIVE') entry.session?.heartbeat(serverTime);
      else depth += entry.queue.length;
    }
    this.#deps.metrics?.gauge('stream_sessions_open', this.#byHandle.size);
    this.#deps.metrics?.gauge('stream_replay_queue_depth', depth);
  }

  async closeAll(code: number, reason: string): Promise<void> {
    for (const entry of [...this.#byHandle.values()]) {
      entry.queue = [];
      if (entry.state === 'LIVE') entry.session?.close(code);
      else entry.ws.close(code, reason);
      this.unregister(entry.handle.sessionId, entry.handle);
    }
  }

  size(): number {
    return this.#byHandle.size;
  }

  stateOf(handle: StreamHandle): StreamEntryState | undefined {
    return this.#byHandle.get(handle.id)?.state;
  }

  queueDepth(handle: StreamHandle): number {
    return this.#byHandle.get(handle.id)?.queue.length ?? 0;
  }

  /** Test hook: queue depth observed in the synchronous section that flipped to LIVE. */
  depthAtLiveTransition(handle: StreamHandle): number | undefined {
    return this.#byHandle.get(handle.id)?.depthAtLive;
  }

  #overflow(entry: Entry): void {
    this.#deps.metrics?.counter('stream_replay_overflow_total');
    this.#deps.log?.('stream.replay_overflow', {
      sessionId: entry.handle.sessionId,
    });
    entry.ws.send(
      JSON.stringify({ type: 'resync-required', reason: 'REPLAY_OVERFLOW' }),
    );
    entry.ws.close(4010, 'REPLAY_OVERFLOW');
    this.unregister(entry.handle.sessionId, entry.handle);
  }
}
