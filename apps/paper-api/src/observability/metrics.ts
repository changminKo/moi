type Labels = Record<string, string>;
const allowed: Record<string, readonly string[]> = {
  market_data_health: ['market', 'state'],
  feed_ping_latency_seconds: [],
  feed_reconnect_total: [],
  recovery_duration_seconds: [],
  rest_snapshot_request_total: ['market', 'result'],
  order_event_total: ['market', 'event_type', 'status'],
  transaction_duration_seconds: ['tx_type'],
  db_lock_wait_seconds: ['lock_type'],
  invariant_violation_total: ['invariant_type', 'market'],
  safety_incident_active: ['scope_type', 'cause_group'],
  emergency_latch_active: [],
  transactional_audit_failure_total: [],
  transaction_error_total: ['tx_type'],
  outbox_oldest_pending_seconds: [],
  runtime_state: ['state'],
  leader_epoch: ['market'],
  leader_lease_held: ['market'],
  leader_lease_wait_seconds: ['market'],
  leader_lease_poll_total: ['market'],
  leader_reelection_total: ['market'],
  lease_lost_total: ['market', 'phase'],
  provider_connections_open: [],
  provider_token_refresh_total: ['result'],
  market_event_rejected_total: ['market', 'reason'],
  outbox_published_total: [],
  outbox_drain_remaining: [],
  outbox_claims_total: ['mode'],
  outbox_shutdown_drain_rounds: [],
  stream_sessions_open: [],
  stream_upgrade_rejected_total: ['reason'],
  stream_replay_queue_depth: [],
  stream_replay_overflow_total: [],
  shutdown_drain_seconds: ['phase'],
  shutdown_forced_total: [],
  http_admission_rejected_total: [],
  http_admission_inflight: [],
  http_admission_drain_remaining: [],
};
export class MetricsRegistry {
  readonly #values = new Map<string, number>();
  counter(name: string, labels: Labels = {}): void {
    this.#add(name, labels, 1);
  }
  gauge(name: string, value: number, labels: Labels = {}): void {
    this.#set(name, labels, value);
  }
  observe(name: string, value: number, labels: Labels = {}): void {
    this.#add(name, labels, value);
  }
  #key(name: string, labels: Labels): string {
    const keys = allowed[name];
    if (!keys) throw new Error(`unknown metric ${name}`);
    for (const key of Object.keys(labels))
      if (!keys.includes(key) || /(?:id|symbol|session|order|key)/i.test(key))
        throw new Error(`unbounded metric label ${key}`);
    return `${name}|${JSON.stringify(
      Object.fromEntries(
        keys
          .filter((key) => labels[key] !== undefined)
          .sort()
          .map((key) => [key, labels[key] as string]),
      ),
    )}`;
  }
  #add(name: string, labels: Labels, value: number): void {
    const key = this.#key(name, labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + value);
  }
  #set(name: string, labels: Labels, value: number): void {
    this.#values.set(this.#key(name, labels), value);
  }
  metrics(): string {
    return `${[...this.#values.entries()]
      .map(([key, value]) => {
        const [name, json] = key.split('|');
        const labels = JSON.parse(json ?? '{}') as Labels;
        const rendered = Object.entries(labels)
          .map(([k, v]) => `${k}="${v.replaceAll('"', '\\"')}"`)
          .join(',');
        return `${name}${rendered ? `{${rendered}}` : ''} ${value}`;
      })
      .join('\n')}\n`;
  }
}
