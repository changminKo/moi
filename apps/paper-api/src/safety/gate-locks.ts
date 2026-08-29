export type GateScope = {
  readonly market?: string;
  readonly symbol?: string;
  readonly account?: string;
};
export interface GateLease {
  readonly release: () => void;
}
type Waiter = {
  readonly exclusive: boolean;
  readonly resolve: (lease: GateLease) => void;
};
type State = { readers: number; writer: boolean; queue: Waiter[] };
const rank = (scope: GateScope): string =>
  `${scope.market ?? '*'}\0${scope.symbol ?? '*'}\0${scope.account ?? '*'}`;
export class GateLocks {
  readonly #states = new Map<string, State>();
  #state(scope: GateScope): State {
    const key = rank(scope);
    let state = this.#states.get(key);
    if (!state) {
      state = { readers: 0, writer: false, queue: [] };
      this.#states.set(key, state);
    }
    return state;
  }
  async acquireShared(scope: GateScope = {}): Promise<GateLease> {
    return this.#acquire(scope, false);
  }
  async acquireExclusive(scope: GateScope = {}): Promise<GateLease> {
    return this.#acquire(scope, true);
  }
  isExclusive(scope: GateScope = {}): boolean {
    return this.#state(scope).writer;
  }
  async acquireSharedMany(scopes: readonly GateScope[]): Promise<GateLease> {
    return this.#acquireMany(scopes, false);
  }
  async acquireExclusiveMany(scopes: readonly GateScope[]): Promise<GateLease> {
    return this.#acquireMany(scopes, true);
  }
  async #acquireMany(
    scopes: readonly GateScope[],
    exclusive: boolean,
  ): Promise<GateLease> {
    const ordered = [...scopes].sort((a, b) => rank(a).localeCompare(rank(b)));
    const leases: GateLease[] = [];
    try {
      for (const scope of ordered)
        leases.push(await this.#acquire(scope, exclusive));
    } catch (error) {
      for (const lease of leases.reverse()) lease.release();
      throw error;
    }
    return {
      release: () => {
        for (const lease of leases.reverse()) lease.release();
      },
    };
  }
  #acquire(scope: GateScope, exclusive: boolean): Promise<GateLease> {
    const state = this.#state(scope);
    if (
      (!exclusive &&
        !state.writer &&
        !state.queue.some((waiter) => waiter.exclusive)) ||
      (exclusive && !state.writer && state.readers === 0)
    ) {
      if (exclusive) state.writer = true;
      else state.readers++;
      return Promise.resolve(this.#lease(state, exclusive));
    }
    return new Promise((resolve) => state.queue.push({ exclusive, resolve }));
  }
  #lease(state: State, exclusive: boolean): GateLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (exclusive) state.writer = false;
        else state.readers--;
        this.#drain(state);
      },
    };
  }
  #drain(state: State): void {
    if (state.writer || state.readers > 0 || state.queue.length === 0) return;
    if (state.queue[0]?.exclusive) {
      const waiter = state.queue.shift() as Waiter;
      state.writer = true;
      waiter.resolve(this.#lease(state, true));
      return;
    }
    while (state.queue[0] && !state.queue[0].exclusive) {
      const waiter = state.queue.shift() as Waiter;
      state.readers++;
      waiter.resolve(this.#lease(state, false));
    }
  }
}
