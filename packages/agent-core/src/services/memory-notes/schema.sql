CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_notes (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('global', 'workspace', 'agent')),
  scope_key      TEXT,
  scope_key_hash TEXT NOT NULL,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  tags           TEXT NOT NULL,
  sensitivity    TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (
    (scope = 'global' AND scope_key IS NULL)
    OR
    (scope IN ('workspace', 'agent') AND scope_key IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_memory_notes_scope_updated
  ON memory_notes(scope, scope_key_hash, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_notes_updated
  ON memory_notes(updated_at DESC);
