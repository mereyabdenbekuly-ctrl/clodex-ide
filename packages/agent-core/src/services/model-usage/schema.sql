CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_usage_records (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL,
  task_id_hash          TEXT NOT NULL,
  purpose               TEXT NOT NULL,
  model_id              TEXT NOT NULL,
  provider_mode         TEXT,
  task_role             TEXT,
  input_tokens          INTEGER NOT NULL,
  cached_input_tokens   INTEGER NOT NULL,
  output_tokens         INTEGER NOT NULL,
  reasoning_tokens      INTEGER NOT NULL,
  total_tokens          INTEGER NOT NULL,
  estimated_cost_usd    REAL,
  latency_ms            INTEGER NOT NULL,
  outcome               TEXT NOT NULL,
  fallback_attempt      INTEGER NOT NULL,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_usage_task_time
  ON model_usage_records(task_id_hash, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_model_usage_model_time
  ON model_usage_records(model_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_model_usage_purpose_time
  ON model_usage_records(purpose, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS model_route_decisions (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL,
  task_id_hash          TEXT NOT NULL,
  purpose               TEXT NOT NULL,
  task_role             TEXT,
  active_model_id       TEXT NOT NULL,
  active_endpoint_id    TEXT,
  proposed_model_id     TEXT,
  proposed_endpoint_id  TEXT,
  selected_model_id     TEXT NOT NULL,
  selected_endpoint_id  TEXT,
  active_routing_admitted INTEGER NOT NULL,
  candidate_count       INTEGER NOT NULL,
  excluded_count        INTEGER NOT NULL,
  replay_safety         TEXT NOT NULL,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_route_decisions_task_time
  ON model_route_decisions(task_id_hash, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS model_budget_events (
  id                    TEXT PRIMARY KEY,
  reservation_id        TEXT,
  policy_ids_json       TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  task_id_hash          TEXT NOT NULL,
  workspace_id          TEXT,
  workspace_id_hash     TEXT,
  provider_id           TEXT NOT NULL,
  amount_usd            REAL NOT NULL,
  status                TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_model_budget_events_time
  ON model_budget_events(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_model_budget_events_reservation
  ON model_budget_events(reservation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_budget_events_provider_time
  ON model_budget_events(provider_id, created_at DESC);

CREATE TABLE IF NOT EXISTS model_provider_quota_windows (
  endpoint_key_hash      TEXT PRIMARY KEY,
  endpoint_key           TEXT NOT NULL,
  rate_limited_until     INTEGER NOT NULL,
  observed_at            INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_provider_quota_deadline
  ON model_provider_quota_windows(rate_limited_until DESC);
