export interface ShutdownLatch {
  close(): void | Promise<void>;
}
export interface ShutdownCoordinatorOptions {
  readonly cancelOnly: () => Promise<void> | void;
  readonly admission: ShutdownLatch;
  readonly drainInflight: (deadline: number) => Promise<void>;
  readonly drainOutbox: (deadline: number) => Promise<void>;
  readonly closeSockets: () => Promise<void>;
  readonly releaseLeases: () => Promise<void>;
  readonly clock?: { now(): number };
  readonly deadlineMs?: number;
}
export class ShutdownCoordinator {
  readonly #o: ShutdownCoordinatorOptions;
  #draining = false;
  constructor(options: ShutdownCoordinatorOptions) {
    this.#o = options;
  }
  get draining(): boolean {
    return this.#draining;
  }
  async drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    await this.#o.cancelOnly();
    await this.#o.admission.close();
    const now = this.#o.clock?.now() ?? Date.now(),
      deadline = now + (this.#o.deadlineMs ?? 30_000);
    await this.#o.drainInflight(deadline);
    await this.#o.drainOutbox(deadline);
    await this.#o.closeSockets();
    await this.#o.releaseLeases();
  }
}
