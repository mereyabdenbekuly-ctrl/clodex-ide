CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_memory_events (
  id                      TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL,
  task_id_hash            TEXT NOT NULL,
  workspace_id            TEXT,
  workspace_id_hash       TEXT NOT NULL,
  type                    TEXT NOT NULL,
  timestamp               INTEGER NOT NULL,
  message_id              TEXT,
  repository_revision     TEXT,
  source                  TEXT,
  source_id_hash          TEXT,
  ingestion_key_hash      TEXT,
  payload_hash            TEXT,
  content_hash            TEXT,
  payload                 TEXT NOT NULL,
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_task_time
  ON evidence_memory_events(task_id_hash, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_workspace_time
  ON evidence_memory_events(workspace_id_hash, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_type_time
  ON evidence_memory_events(type, timestamp DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_memory_event_ingestion
  ON evidence_memory_events(task_id_hash, ingestion_key_hash)
  WHERE ingestion_key_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_memory_event_source
  ON evidence_memory_events(task_id_hash, source, source_id_hash, timestamp DESC);

CREATE TABLE IF NOT EXISTS evidence_memory_claims (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL,
  task_id_hash          TEXT NOT NULL,
  workspace_id          TEXT,
  workspace_id_hash     TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  subject               TEXT NOT NULL,
  subject_hash          TEXT NOT NULL,
  text                  TEXT NOT NULL,
  status                TEXT NOT NULL,
  confidence            REAL NOT NULL,
  valid_at_revision     TEXT,
  invalidated_by        TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_claims_task_status
  ON evidence_memory_claims(task_id_hash, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_claims_subject
  ON evidence_memory_claims(task_id_hash, subject_hash, updated_at DESC);

CREATE TABLE IF NOT EXISTS evidence_memory_claim_evidence (
  id          TEXT PRIMARY KEY,
  claim_id    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(claim_id, event_id),
  FOREIGN KEY(claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES evidence_memory_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_evidence_claim
  ON evidence_memory_claim_evidence(claim_id);

CREATE TABLE IF NOT EXISTS evidence_memory_claim_entities (
  id          TEXT PRIMARY KEY,
  claim_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  value       TEXT NOT NULL,
  value_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(claim_id, type, value_hash),
  FOREIGN KEY(claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_entities_lookup
  ON evidence_memory_claim_entities(type, value_hash, claim_id);

CREATE TABLE IF NOT EXISTS evidence_memory_claim_relations (
  id             TEXT PRIMARY KEY,
  from_claim_id  TEXT NOT NULL,
  to_claim_id    TEXT NOT NULL,
  type           TEXT NOT NULL,
  origin         TEXT NOT NULL DEFAULT 'manual',
  reason         TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE(from_claim_id, to_claim_id, type),
  FOREIGN KEY(from_claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE,
  FOREIGN KEY(to_claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_relations_from
  ON evidence_memory_claim_relations(from_claim_id);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_relations_to
  ON evidence_memory_claim_relations(to_claim_id);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_relations_origin
  ON evidence_memory_claim_relations(origin, type, created_at DESC);

CREATE TABLE IF NOT EXISTS evidence_memory_code_fingerprints (
  id                       TEXT PRIMARY KEY,
  claim_id                 TEXT NOT NULL,
  task_id_hash             TEXT NOT NULL,
  entity_type              TEXT NOT NULL,
  entity_value_hash        TEXT NOT NULL,
  file_path                TEXT NOT NULL,
  symbol_name              TEXT,
  codegraph_node_id        TEXT,
  expected_content_hash    TEXT NOT NULL,
  expected_symbol_hash     TEXT,
  observed_content_hash    TEXT NOT NULL,
  observed_symbol_hash     TEXT,
  expected_revision        TEXT,
  observed_revision        TEXT,
  graph_context            TEXT NOT NULL,
  status                   TEXT NOT NULL,
  captured_at              INTEGER NOT NULL,
  last_validated_at        INTEGER NOT NULL,
  UNIQUE(claim_id, entity_type, entity_value_hash),
  FOREIGN KEY(claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_code_fingerprints_claim
  ON evidence_memory_code_fingerprints(claim_id, status);

CREATE INDEX IF NOT EXISTS idx_evidence_memory_code_fingerprints_entity
  ON evidence_memory_code_fingerprints(task_id_hash, entity_type, entity_value_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_memory_claim_fts USING fts5(
  claim_id UNINDEXED,
  task_hash UNINDEXED,
  subject,
  text,
  entities,
  tokenize = 'unicode61'
);
