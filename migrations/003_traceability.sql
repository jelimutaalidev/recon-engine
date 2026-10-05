CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  compiler_identity TEXT NOT NULL,
  configuration_identity TEXT NOT NULL,
  input_manifest_hash TEXT NOT NULL,
  output_identity TEXT
);
CREATE TABLE IF NOT EXISTS derivations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  operation TEXT NOT NULL,
  operation_version TEXT NOT NULL,
  inputs TEXT NOT NULL,
  outputs TEXT NOT NULL,
  provenance TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_derivations_run ON derivations(run_id);
CREATE INDEX IF NOT EXISTS idx_derivations_operation ON derivations(operation, operation_version);
CREATE TABLE IF NOT EXISTS run_outputs (
  run_id TEXT NOT NULL REFERENCES runs(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_run_outputs_entity ON run_outputs(entity_id);
