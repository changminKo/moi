import type { StartupLatch } from '../lifecycle/startup-coordinator.js';

/**
 * Process-local admission / matching latch. Starts closed so a process that
 * never reaches SERVING is fail-closed by construction.
 */
export class AdmissionLatch implements StartupLatch {
  #closed = true;

  get isClosed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#closed = true;
  }

  open(): void {
    this.#closed = false;
  }
}
