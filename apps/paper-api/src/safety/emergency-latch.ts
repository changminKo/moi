import { DomainError } from '@skipjack/trading-core';
export class EmergencyLatch {
  #admission = false; #matching = false; #fatal: Error | undefined;
  get admissionOpen(): boolean { return this.#admission; }
  get matchingOpen(): boolean { return this.#matching; }
  get lastFatal(): Error | undefined { return this.#fatal; }
  openAdmission(): void { if (!this.#fatal) this.#admission = true; }
  openMatching(): void { if (!this.#fatal) this.#matching = true; }
  closeAdmission(): void { this.#admission = false; }
  closeMatching(): void { this.#matching = false; }
  close(): void { this.closeAdmission(); this.closeMatching(); }
  closeOnFatal(error: unknown): void { this.#fatal = error instanceof Error ? error : new Error(String(error)); this.close(); }
  assertAdmission(): void { if (!this.#admission) throw new DomainError('SERVICE_UNAVAILABLE', 'admission latch is closed'); }
  assertMatching(): void { if (!this.#matching) throw new DomainError('SERVICE_UNAVAILABLE', 'matching latch is closed'); }
}
