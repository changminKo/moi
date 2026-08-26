import type { SafetyIncident } from './capabilities.js';

export interface IncidentRepository {
  create(incident: SafetyIncident): Promise<SafetyIncident>;
  active(scope?: SafetyIncident['scope']): Promise<readonly SafetyIncident[]>;
  resolveCas(input: {
    incidentId: string;
    version: bigint;
    recoveryEpoch: bigint | null;
  }): Promise<SafetyIncident | undefined>;
}

/** A deterministic repository seam; production wiring can replace this with the UnitOfWork-backed implementation. */
export function createIncidentRepository(
  seed: readonly SafetyIncident[] = [],
): IncidentRepository {
  const incidents = new Map<string, SafetyIncident>(
    seed.map((incident) => [
      incident.incidentId,
      { ...incident, denied: new Set(incident.denied) },
    ]),
  );
  return {
    async create(incident) {
      const existing = incidents.get(incident.incidentId);
      if (existing?.status === 'ACTIVE') return existing;
      incidents.set(incident.incidentId, {
        ...incident,
        denied: new Set(incident.denied),
      });
      return incidents.get(incident.incidentId) as SafetyIncident;
    },
    async active(scope) {
      return [...incidents.values()].filter(
        (incident) =>
          incident.status === 'ACTIVE' &&
          (scope === undefined ||
            (incident.scope.type === scope.type &&
              incident.scope.id === scope.id)),
      );
    },
    async resolveCas({ incidentId, version, recoveryEpoch }) {
      const current = incidents.get(incidentId);
      if (
        current === undefined ||
        current.status !== 'ACTIVE' ||
        current.version !== version ||
        current.recoveryEpoch !== recoveryEpoch
      )
        return undefined;
      const resolved: SafetyIncident = {
        ...current,
        status: 'RESOLVED',
        version: current.version + 1n,
      };
      incidents.set(incidentId, resolved);
      return resolved;
    },
  };
}
