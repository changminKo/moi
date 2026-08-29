import { randomUUID } from 'node:crypto';
import type { Capability, SafetyIncident } from './capabilities.js';
import { EmergencyLatch } from './emergency-latch.js';
import { GateLocks, type GateScope } from './gate-locks.js';
import {
  createIncidentRepository,
  type IncidentRepository,
} from './incident-repository.js';

export interface IncidentServiceOptions {
  readonly repository?: IncidentRepository;
  readonly gates?: GateLocks;
  readonly latches?: EmergencyLatch;
  readonly appendAudit?: (event: {
    readonly eventType: string;
    readonly payload: unknown;
  }) => Promise<void>;
}
export interface ActivateIncidentInput {
  readonly incidentId?: string;
  readonly scope: SafetyIncident['scope'];
  readonly denied: readonly Capability[] | ReadonlySet<Capability>;
  readonly causeCode: string;
  readonly recoveryEpoch?: bigint | null;
}
export class IncidentService {
  readonly #repository: IncidentRepository;
  readonly #gates: GateLocks;
  readonly #latches: EmergencyLatch;
  readonly #appendAudit?: IncidentServiceOptions['appendAudit'];
  constructor(options: IncidentServiceOptions = {}) {
    this.#repository = options.repository ?? createIncidentRepository();
    this.#gates = options.gates ?? new GateLocks();
    this.#latches = options.latches ?? new EmergencyLatch();
    this.#appendAudit = options.appendAudit;
  }
  get repository(): IncidentRepository {
    return this.#repository;
  }
  async activate(input: ActivateIncidentInput): Promise<SafetyIncident> {
    const lease = await this.#gates.acquireExclusive(this.#scope(input.scope));
    try {
      const incident: SafetyIncident = {
        incidentId: input.incidentId ?? randomUUID(),
        scope: input.scope,
        denied: new Set(input.denied),
        causeCode: input.causeCode,
        recoveryEpoch: input.recoveryEpoch ?? null,
        version: 1n,
        status: 'ACTIVE',
      };
      const result = await this.#repository.create(incident);
      await this.#audit('SAFETY_INCIDENT_ACTIVATED', result);
      return result;
    } catch (error) {
      this.#latches.closeOnFatal(error);
      throw error;
    } finally {
      lease.release();
    }
  }
  async resolveCas(input: {
    incidentId: string;
    version: bigint;
    recoveryEpoch: bigint | null;
  }): Promise<SafetyIncident | undefined> {
    const current = (await this.#repository.active()).find(
      (incident) => incident.incidentId === input.incidentId,
    );
    if (
      current === undefined ||
      current.version !== input.version ||
      current.recoveryEpoch !== input.recoveryEpoch
    )
      return undefined;
    const lease = await this.#gates.acquireExclusive(
      this.#scope(current.scope),
    );
    try {
      const result = await this.#repository.resolveCas(input);
      if (result !== undefined)
        await this.#audit('SAFETY_INCIDENT_RESOLVED', result);
      return result;
    } catch (error) {
      this.#latches.closeOnFatal(error);
      throw error;
    } finally {
      lease.release();
    }
  }
  async active(
    scope?: SafetyIncident['scope'],
  ): Promise<readonly SafetyIncident[]> {
    return this.#repository.active(scope);
  }
  #scope(scope: SafetyIncident['scope']): GateScope {
    return scope.type === 'ACCOUNT'
      ? { account: scope.id }
      : scope.type === 'SYMBOL'
        ? { market: scope.id, symbol: scope.id }
        : scope.type === 'MARKET'
          ? { market: scope.id }
          : {};
  }
  async #audit(eventType: string, incident: SafetyIncident): Promise<void> {
    await this.#appendAudit?.({
      eventType,
      payload: {
        ...incident,
        denied: [...incident.denied],
        version: incident.version.toString(),
        recoveryEpoch: incident.recoveryEpoch?.toString() ?? null,
      },
    });
  }
}
