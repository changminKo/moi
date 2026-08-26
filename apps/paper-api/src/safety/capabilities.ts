export const ALL_CAPABILITIES = Object.freeze([
  'PLACE',
  'AMEND',
  'CANCEL',
  'MATCH',
  'TRIGGER',
  'RECOVER',
] as const);
export type Capability = (typeof ALL_CAPABILITIES)[number];
export type IncidentScopeType = 'GLOBAL' | 'MARKET' | 'SYMBOL' | 'ACCOUNT';
export interface SafetyIncident {
  readonly incidentId: string;
  readonly scope: { readonly type: IncidentScopeType; readonly id: string };
  readonly denied: ReadonlySet<Capability>;
  readonly causeCode: string;
  readonly recoveryEpoch: bigint | null;
  readonly version: bigint;
  readonly status: 'ACTIVE' | 'RESOLVED';
}
export interface EffectiveCapabilities {
  readonly allowed: readonly Capability[];
  readonly denied: ReadonlySet<Capability>;
}
export function intersectCapabilities(
  incidents: readonly SafetyIncident[],
): EffectiveCapabilities {
  const denied = new Set<Capability>();
  for (const incident of incidents) {
    if (incident.status !== 'ACTIVE') continue;
    for (const capability of incident.denied) denied.add(capability);
  }
  return Object.freeze({
    allowed: Object.freeze(
      ALL_CAPABILITIES.filter((capability) => !denied.has(capability)),
    ),
    denied,
  });
}
export function deniedForMode(
  mode: 'CANCEL_ONLY' | 'READ_ONLY',
): ReadonlySet<Capability> {
  return new Set(
    mode === 'CANCEL_ONLY'
      ? (['PLACE', 'AMEND', 'MATCH', 'TRIGGER', 'RECOVER'] as Capability[])
      : ([
          'PLACE',
          'AMEND',
          'CANCEL',
          'MATCH',
          'TRIGGER',
          'RECOVER',
        ] as Capability[]),
  );
}
