CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  chains TEXT NOT NULL DEFAULT '[]',
  repository TEXT,
  commit_sha TEXT,
  version TEXT,
  scope TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  chain_id TEXT,
  contract_type TEXT NOT NULL,
  source_file TEXT,
  source_verified INTEGER,
  compiler_version TEXT,
  is_proxy INTEGER,
  implementation_id TEXT,
  deployment_status TEXT
);

CREATE INDEX idx_contracts_chain_address ON contracts(chain_id, address);

CREATE TABLE functions (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  name TEXT NOT NULL,
  signature TEXT NOT NULL,
  selector TEXT,
  visibility TEXT NOT NULL,
  mutability TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '[]',
  returns TEXT NOT NULL DEFAULT '[]',
  modifiers TEXT NOT NULL DEFAULT '[]',
  source TEXT
);

CREATE INDEX idx_functions_contract ON functions(contract_id);

CREATE TABLE state_variables (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  visibility TEXT NOT NULL,
  slot TEXT,
  source TEXT
);

CREATE INDEX idx_state_variables_contract ON state_variables(contract_id);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  chain_id TEXT,
  asset_type TEXT NOT NULL,
  decimals INTEGER,
  custody TEXT,
  underlying_asset_id TEXT
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  contract_id TEXT REFERENCES contracts(id),
  name TEXT NOT NULL,
  role_type TEXT NOT NULL,
  holder TEXT,
  source TEXT
);

CREATE TABLE dependencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dependency_type TEXT NOT NULL,
  address TEXT,
  chain_id TEXT,
  interface TEXT,
  trust_level TEXT
);

CREATE TABLE provenance (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  location TEXT,
  repository TEXT,
  commit_sha TEXT,
  file TEXT,
  line_start INTEGER,
  line_end INTEGER,
  chain_id TEXT,
  address TEXT,
  block_number INTEGER,
  description TEXT,
  unavailable INTEGER
);

CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_relationships_source ON relationships(source_id);
CREATE INDEX idx_relationships_target ON relationships(target_id);
CREATE INDEX idx_relationships_type ON relationships(type);

CREATE TABLE relationship_provenance (
  relationship_id TEXT NOT NULL REFERENCES relationships(id),
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (relationship_id, position)
);

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_id TEXT,
  value TEXT,
  confidence_level TEXT NOT NULL,
  confidence_score REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_facts_subject ON facts(subject_id);
CREATE INDEX idx_facts_object ON facts(object_id);

CREATE TABLE fact_provenance (
  fact_id TEXT NOT NULL REFERENCES facts(id),
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (fact_id, position)
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  confidence_level TEXT NOT NULL,
  confidence_score REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE observation_basis (
  observation_id TEXT NOT NULL REFERENCES observations(id),
  fact_id TEXT NOT NULL REFERENCES facts(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (observation_id, position)
);

CREATE INDEX idx_observation_basis_fact ON observation_basis(fact_id);

CREATE TABLE observation_provenance (
  observation_id TEXT NOT NULL REFERENCES observations(id),
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (observation_id, position)
);

CREATE TABLE assumptions (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence_level TEXT NOT NULL,
  confidence_score REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE assumption_basis (
  assumption_id TEXT NOT NULL REFERENCES assumptions(id),
  observation_id TEXT NOT NULL REFERENCES observations(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (assumption_id, position)
);

CREATE INDEX idx_assumption_basis_observation ON assumption_basis(observation_id);

CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence_level TEXT NOT NULL,
  confidence_score REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE hypothesis_basis (
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id),
  target_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (hypothesis_id, position)
);

CREATE TABLE hypothesis_entities (
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id),
  entity_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (hypothesis_id, position)
);

CREATE TABLE hypothesis_conditions (
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id),
  position INTEGER NOT NULL,
  condition TEXT NOT NULL,
  PRIMARY KEY (hypothesis_id, position)
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  evidence_type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE evidence_supports (
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  target_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (evidence_id, position)
);

CREATE TABLE evidence_contradicts (
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  target_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (evidence_id, position)
);

CREATE TABLE evidence_provenance (
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (evidence_id, position)
);
