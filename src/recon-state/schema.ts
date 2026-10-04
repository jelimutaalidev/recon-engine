import { z } from 'zod';
import { ProjectSchema } from '../domain/project.js';
import { ContractSchema } from '../domain/contract.js';
import { FunctionSchema } from '../domain/function.js';
import { StateVariableSchema } from '../domain/state-variable.js';
import { AssetSchema } from '../domain/asset.js';
import { RoleSchema } from '../domain/role.js';
import { DependencySchema } from '../domain/dependency.js';
import { RelationshipSchema } from '../relationships/relationship.js';
import { FactSchema } from '../epistemic/fact.js';
import { ObservationSchema } from '../epistemic/observation.js';
import { AssumptionSchema } from '../epistemic/assumption.js';
import { HypothesisSchema } from '../epistemic/hypothesis.js';
import { EvidenceSchema } from '../epistemic/evidence.js';
import { ProvenanceSchema } from '../epistemic/provenance.js';

export const SUPPORTED_SCHEMA_VERSIONS = ['recon-state/v1'] as const;

export const ReconStateSchema = z.strictObject({
  schema_version: z.string().min(1).default('recon-state/v1'),
  project: ProjectSchema.optional(),
  contracts: z.array(ContractSchema).default([]),
  functions: z.array(FunctionSchema).default([]),
  state_variables: z.array(StateVariableSchema).default([]),
  assets: z.array(AssetSchema).default([]),
  roles: z.array(RoleSchema).default([]),
  dependencies: z.array(DependencySchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  facts: z.array(FactSchema).default([]),
  observations: z.array(ObservationSchema).default([]),
  assumptions: z.array(AssumptionSchema).default([]),
  hypotheses: z.array(HypothesisSchema).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  provenance: z.array(ProvenanceSchema).default([]),
});

export type ReconState = z.infer<typeof ReconStateSchema>;
export type ReconStateInput = z.input<typeof ReconStateSchema>;
