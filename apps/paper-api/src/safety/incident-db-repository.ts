import { sql } from 'kysely';
import type { Database } from '../db/database.js';
import type { Capability, SafetyIncident } from './capabilities.js';
import type { IncidentRepository } from './incident-repository.js';

interface Row {
  id: string;
  scope_type: SafetyIncident['scope']['type'] | 'LOCAL';
  scope_id: string | null;
  cause_code: string;
  blocked_capabilities: string[];
  recovery_epoch: string;
  status: 'ACTIVE' | 'RESOLVED';
  version: string;
}

function toIncident(row: Row): SafetyIncident {
  return {
    incidentId: row.id,
    scope: {
      type: row.scope_type as SafetyIncident['scope']['type'],
      id: row.scope_id ?? '*',
    },
    denied: new Set(row.blocked_capabilities as Capability[]),
    causeCode: row.cause_code,
    recoveryEpoch:
      row.recovery_epoch === null ? null : BigInt(row.recovery_epoch),
    version: BigInt(row.version),
    status: row.status,
  };
}

export interface DbIncidentOptions {
  /** Marks operator-only incidents (`source = 'MANUAL'`) by cause code. */
  readonly manualCauseCodes?: ReadonlySet<string>;
}

/**
 * `safety_incidents`-backed repository (§6.1 FAILED_CLOSED survives restarts).
 * GLOBAL/LOCAL rows carry a null scope_id per the table check constraint.
 */
export function createDbIncidentRepository(
  db: Database,
  options: DbIncidentOptions = {},
): IncidentRepository {
  const manual = options.manualCauseCodes ?? new Set<string>();
  return {
    async create(incident) {
      const scopeId =
        incident.scope.type === 'GLOBAL' ? null : incident.scope.id;
      const source = manual.has(incident.causeCode) ? 'MANUAL' : 'AUTOMATIC';
      await sql`
        insert into safety_incidents
          (id, scope_type, scope_id, source, cause_code, reason, blocked_capabilities, recovery_epoch, status, version)
        values (${incident.incidentId}, ${incident.scope.type}, ${scopeId}, ${source}, ${incident.causeCode},
          ${incident.causeCode}, ${sql.val([...incident.denied])}::text[], ${incident.recoveryEpoch ?? 0n}, 'ACTIVE', ${incident.version})
        on conflict (id) do nothing
      `.execute(db);
      const row =
        await sql<Row>`select * from safety_incidents where id = ${incident.incidentId}`.execute(
          db,
        );
      return toIncident(row.rows[0] as Row);
    },
    async active(scope) {
      const rows = await sql<Row>`
        select * from safety_incidents where status = 'ACTIVE' order by activated_at, id
      `.execute(db);
      return rows.rows
        .map(toIncident)
        .filter(
          (incident) =>
            scope === undefined ||
            (incident.scope.type === scope.type &&
              incident.scope.id === scope.id),
        );
    },
    async resolveCas({ incidentId, version, recoveryEpoch }) {
      const result = await sql<Row>`
        update safety_incidents
        set status = 'RESOLVED', resolved_at = now(), resolved_by = 'runtime', version = version + 1
        where id = ${incidentId} and status = 'ACTIVE' and version = ${version}
          and (${recoveryEpoch === null} or recovery_epoch = ${recoveryEpoch ?? 0n})
        returning *
      `.execute(db);
      const row = result.rows[0];
      return row === undefined ? undefined : toIncident(row);
    },
  };
}
