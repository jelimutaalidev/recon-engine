import { z } from 'zod';

export type TraceStatus = 'COMPLETE' | 'PARTIAL' | 'MISSING' | 'NOT_APPLICABLE';
export type ReconRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL';
export type DerivationStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface TraceReference {
  entity_type: string;
  entity_id: string;
}

export interface SourceIdentity {
  source_hash: string;
  manifest_hash: string;
  repository?: string;
  commit?: string;
  source_root?: string;
}

export interface CompilerIdentity {
  compiler: string;
  version: string;
  binary_hash?: string;
  backend: string;
}

export interface ConfigurationIdentity {
  config_hash: string;
}

export interface OutputIdentity {
  output_hash: string;
  serialization: string;
}

export interface ReconRun {
  id: string;
  project_id: string;
  schema_version: string;
  analyzer_version: string;
  started_at: string;
  completed_at?: string;
  status: ReconRunStatus;
  source_identity: SourceIdentity;
  compiler_identity: CompilerIdentity;
  configuration_identity: ConfigurationIdentity;
  input_manifest_hash: string;
  output_identity?: OutputIdentity;
}

export interface Derivation {
  id: string;
  run_id: string;
  operation: string;
  operation_version: string;
  inputs: TraceReference[];
  outputs: TraceReference[];
  provenance: string[];
  status: DerivationStatus;
  metadata?: Record<string, unknown>;
}

export interface RunOutputRecord {
  run_id: string;
  entity_type: string;
  entity_id: string;
  content_hash: string;
}

export interface TraceabilityState {
  runs: ReconRun[];
  derivations: Derivation[];
  outputs: RunOutputRecord[];
}

export type MATERIAL_ENTITY_TYPE =
  | 'contract'
  | 'function'
  | 'state_variable'
  | 'relationship'
  | 'fact';
export const MATERIAL_ENTITY_TYPES = [
  'contract',
  'function',
  'state_variable',
  'relationship',
  'fact',
] as const;

export const TraceStatusSchema = z.enum([
  'COMPLETE',
  'PARTIAL',
  'MISSING',
  'NOT_APPLICABLE',
]);
export const ReconRunStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL']);
export const DerivationStatusSchema = z.enum(['COMPLETED', 'PARTIAL', 'FAILED']);

export const TraceReferenceSchema = z.strictObject({
  entity_type: z.string(),
  entity_id: z.string(),
});

export const SourceIdentitySchema = z.strictObject({
  source_hash: z.string(),
  manifest_hash: z.string(),
  repository: z.string().optional(),
  commit: z.string().optional(),
  source_root: z.string().optional(),
});

export const CompilerIdentitySchema = z.strictObject({
  compiler: z.string(),
  version: z.string(),
  binary_hash: z.string().optional(),
  backend: z.string(),
});

export const ConfigurationIdentitySchema = z.strictObject({
  config_hash: z.string(),
});

export const OutputIdentitySchema = z.strictObject({
  output_hash: z.string(),
  serialization: z.string(),
});

export const ReconRunSchema = z.strictObject({
  id: z.string(),
  project_id: z.string(),
  schema_version: z.string(),
  analyzer_version: z.string(),
  started_at: z.string(),
  completed_at: z.string().optional(),
  status: ReconRunStatusSchema,
  source_identity: SourceIdentitySchema,
  compiler_identity: CompilerIdentitySchema,
  configuration_identity: ConfigurationIdentitySchema,
  input_manifest_hash: z.string(),
  output_identity: OutputIdentitySchema.optional(),
});

export const DerivationSchema = z.strictObject({
  id: z.string(),
  run_id: z.string(),
  operation: z.string(),
  operation_version: z.string(),
  inputs: z.array(TraceReferenceSchema),
  outputs: z.array(TraceReferenceSchema),
  provenance: z.array(z.string()),
  status: DerivationStatusSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const RunOutputRecordSchema = z.strictObject({
  run_id: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  content_hash: z.string(),
});

export const TraceabilitySchema = z.strictObject({
  runs: z.array(ReconRunSchema).default([]),
  derivations: z.array(DerivationSchema).default([]),
  outputs: z.array(RunOutputRecordSchema).default([]),
});
