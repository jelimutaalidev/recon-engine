import { z } from 'zod';
import { ASSUMPTION_STATUSES } from '../epistemic/assumption.js';
import { confidenceSchema } from '../epistemic/confidence.js';
import { HYPOTHESIS_STATUSES } from '../epistemic/hypothesis.js';
import { ProvenanceSchema } from '../epistemic/provenance.js';
import { ENTITY_REF_PATTERN, FACT_REF_PATTERN } from '../epistemic/refs.js';
import {
  ASSET_TYPES,
  DEPENDENCY_TYPES,
  MUTABILITIES,
  ROLE_TYPES,
  VISIBILITIES,
} from '../domain/enums.js';

export const EVIDENCE_CLASSES = ['E1', 'E2', 'E3'] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export const evidenceClassSchema = z.enum(EVIDENCE_CLASSES);

export const SEMANTIC_STATUSES = ['COMPLETE', 'PARTIAL', 'FAILED'] as const;
export type SemanticStatus = (typeof SEMANTIC_STATUSES)[number];
export const semanticStatusSchema = z.enum(SEMANTIC_STATUSES);

export const SEMANTIC_STAGES = [
  'intake',
  'transitions',
  'custody',
  'accounting',
  'authority',
  'trust',
  'ladder',
  'finalize',
  'validate',
] as const;
export type SemanticStage = (typeof SEMANTIC_STAGES)[number];

export type SinvReason =
  | 'schema'
  | 'ids_unsorted'
  | 'basis_missing'
  | 'basis_unresolvable'
  | 'provenance_incomplete'
  | 'epistemic_upgrade'
  | 'epistemic_leak'
  | 'unattributed'
  | 'unknown_flattened'
  | 'hash_mismatch'
  | 'leakage'
  | 'binding_mismatch'
  | 'scope_conflict'
  | 'fidelity_mismatch'
  | 'envelope_invalid';

export const INVARIANT_STATUSES = ['OPEN', 'SUPPORTED', 'WEAKENED', 'REJECTED'] as const;
export type InvariantStatus = (typeof INVARIANT_STATUSES)[number];
export const invariantStatusSchema = z.enum(INVARIANT_STATUSES);

export const AUTHORITY_KINDS: readonly [...typeof ROLE_TYPES, 'unknown'] = [
  ...ROLE_TYPES,
  'unknown',
];
export const authorityKindSchema = z.enum(AUTHORITY_KINDS);

export const SEM_OBS_REF = /^semobs:.+/;
export const SEM_ASM_REF = /^semasm:.+/;
export const SEM_EPISTEMIC_REF = /^(?:semobs|semasm|semhyp):.+/;

const SEM_HYP_REF = /^semhyp:.+/;
const SEM_INV_REF = /^seminv:.+/;
const SEMC_REF = /^semc:.+/;
const SEMT_REF = /^semt:.+/;
const SEMA_REF = /^sema:.+/;
const SEMK_REF = /^semk:.+/;
const SEMCL_REF = /^semcl:.+/;
const SEMACC_REF = /^semacc:.+/;
const SEMAU_REF = /^semau:.+/;
const SEMDEP_REF = /^semdep:.+/;
const SEMTC_REF = /^semtc:.+/;
const SEMANTIC_RECORD_REF = /^sem[a-z]+:.+/;
const CONTRACT_REF = /^contract:.+/;
const FUNCTION_REF = /^function:.+/;
const STATE_REF = /^state:.+/;
const HEX_64_REF = /^[0-9a-f]{64}$/;

const addressField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^0x[0-9a-fA-F]{40}$/);
const chainIdField = z.string().trim().toLowerCase().min(1);
const basisField = z.array(z.string().min(1)).min(1);

const SEMANTIC_KINDS = ['proxy', 'implementation', 'library', 'token', 'pool', 'unknown'] as const;
const CALL_KINDS = [
  'internal',
  'external',
  'super',
  'self-external',
  'new',
  'delegatecall',
  'staticcall',
  'lowlevel',
  'indirect',
] as const;
const FIDELITY_FLAGS = ['syntactic', 'assembly_skipped', 'file_dropped'] as const;
const UNKNOWN_REASONS = [
  'unresolved_call',
  'unsupported_assembly',
  'out_of_scope_target',
  'no_evidence',
  'syntactic_fidelity',
  'dropped_file',
] as const;
const INVARIANT_CLASSES = [
  'auth',
  'custody',
  'accounting',
  'isolation',
  'external_trust',
  'temporal',
  'other',
] as const;
const RELATION_KINDS = [
  'assets_shares',
  'debt_collateral',
  'reserves_liquidity',
  'rewards_eligible_stake',
  'fees_protocol_user',
] as const;
const DERIVATION_TAGS = ['paired-storage', 'interface-structural'] as const;

export const UnknownIndexEntrySchema = z.strictObject({
  record_ref: z.string().min(1),
  field: z.string().min(1),
  reason: z.enum(UNKNOWN_REASONS),
  basis: basisField,
});
export type UnknownIndexEntry = z.infer<typeof UnknownIndexEntrySchema>;

export const ContractSemanticsSchema = z.strictObject({
  id: z.string().regex(SEMC_REF),
  contract_id: z.string().regex(CONTRACT_REF),
  semantic_kind: z.enum(SEMANTIC_KINDS),
  bases_evidence: z.array(
    z.strictObject({
      base: z.string().min(1),
      evidence_class: evidenceClassSchema,
    }),
  ),
  notes: z.array(UnknownIndexEntrySchema),
  basis: basisField,
});
export type ContractSemantics = z.infer<typeof ContractSemanticsSchema>;

export const StateTransitionSchema = z.strictObject({
  id: z.string().regex(SEMT_REF),
  function_id: z.string().regex(FUNCTION_REF),
  contract_id: z.string().regex(CONTRACT_REF),
  pre_state_reads: z.array(z.string().regex(STATE_REF)),
  writes: z.array(
    z.strictObject({
      state_var_id: z.string().regex(STATE_REF),
      kind: z.enum(['write', 'readwrite']),
    }),
  ),
  external_effects: z.array(
    z.strictObject({
      call_kind: z.enum(CALL_KINDS),
      target_ref: z.string().min(1).optional(),
      target_evidence: z.enum(['E1', 'E3']),
      value_handling: z.enum(['payable', 'nonpayable']),
      basis: basisField,
    }),
  ),
  asset_movements: z.array(
    z.strictObject({
      kind: z.enum(['transfer', 'mint', 'burn', 'approve', 'deposit', 'withdraw']),
      asset_ref: z.string().regex(SEMA_REF).optional(),
      direction: z.string().min(1),
      evidence_class: evidenceClassSchema,
      basis: basisField,
    }),
  ),
  post_state_observations: z.array(z.string().regex(FACT_REF_PATTERN)),
  state_mutation: z.enum(['none', 'storage']),
  fidelity_flags: z.array(z.enum(FIDELITY_FLAGS)),
  unknowns: z.array(UnknownIndexEntrySchema),
  basis: basisField,
});
export type StateTransition = z.infer<typeof StateTransitionSchema>;

export const AssetRecordSchema = z.strictObject({
  name: z.string().trim().min(1),
  address: addressField.optional(),
  chain_id: chainIdField.optional(),
  asset_type: z.enum(ASSET_TYPES),
  decimals: z.number().int().min(0).max(255).optional(),
  custody: z.string().trim().min(1).optional(),
  represents_asset_id: z.string().regex(SEMA_REF).optional(),
  evidence_class: evidenceClassSchema,
  basis: basisField,
  id: z.string().regex(SEMA_REF),
});
export type AssetRecord = z.infer<typeof AssetRecordSchema>;

export const CustodyRecordSchema = z.strictObject({
  id: z.string().regex(SEMK_REF),
  asset_id: z.string().regex(SEMA_REF),
  holder_contract_id: z.string().regex(CONTRACT_REF),
  location_kind: z.enum(['contract', 'unknown']),
  basis: basisField,
});
export type CustodyRecord = z.infer<typeof CustodyRecordSchema>;

export const ClaimRecordSchema = z.strictObject({
  id: z.string().regex(SEMCL_REF),
  holder_ref: z.string().min(1),
  claim_on: z.string().regex(SEMA_REF),
  via: z.string().regex(SEMA_REF).optional(),
  basis: basisField,
  epistemic: z.literal('observation'),
});
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

export const AccountingRelationSchema = z.strictObject({
  id: z.string().regex(SEMACC_REF),
  relation_kind: z.enum(RELATION_KINDS),
  endpoints: z.array(z.string().regex(SEMANTIC_RECORD_REF)).min(1),
  derivation: z.enum(DERIVATION_TAGS),
  evidence_class: z.literal('E2'),
  basis: basisField,
  epistemic: z.literal('observation'),
  unknowns: z.array(UnknownIndexEntrySchema),
});
export type AccountingRelation = z.infer<typeof AccountingRelationSchema>;

export const AuthorityChainSchema = z.strictObject({
  id: z.string().regex(SEMAU_REF),
  links: z.strictObject({
    actor: z.string().min(1),
    authority: z.string().min(1),
    function_id: z.string().regex(FUNCTION_REF),
    transition_id: z.string().regex(SEMT_REF).optional(),
    impact: z.string().min(1),
  }),
  authority_kind: authorityKindSchema,
  gate: z.strictObject({
    modifiers: z.array(z.string().trim().min(1)),
    visibility: z.enum(VISIBILITIES),
    mutability: z.enum(MUTABILITIES),
  }),
  per_link: z.array(
    z.strictObject({
      link_kind: z.string().min(1),
      evidence_class: evidenceClassSchema,
      basis: basisField,
      unknown: z.boolean().optional(),
    }),
  ),
  status: z.enum(['complete', 'partial']),
});
export type AuthorityChain = z.infer<typeof AuthorityChainSchema>;

export const ExternalDependencySchema = z.strictObject({
  name: z.string().trim().min(1),
  dependency_type: z.enum(DEPENDENCY_TYPES),
  address: addressField.optional(),
  chain_id: chainIdField.optional(),
  interface: z.string().trim().min(1).optional(),
  trust_level: z.string().trim().min(1).optional(),
  basis: basisField,
  id: z.string().regex(SEMDEP_REF),
});
export type ExternalDependency = z.infer<typeof ExternalDependencySchema>;

export const TrustCapabilitySchema = z.strictObject({
  id: z.string().regex(SEMTC_REF),
  dependency_ref: z.string().regex(SEMDEP_REF),
  direction: z.enum(['observed', 'consumed', 'unknown']),
  capabilities: z.array(z.string().min(1)),
  trust_assumption_ref: z.string().regex(SEM_ASM_REF),
  failure_semantics: z.enum(['unknown']),
  basis: basisField,
});
export type TrustCapability = z.infer<typeof TrustCapabilitySchema>;

export const SemanticObservationSchema = z
  .strictObject({
    type: z.literal('OBSERVATION'),
    statement: z.string().trim().min(1),
    based_on: z.array(z.string().regex(FACT_REF_PATTERN)),
    provenance: z.array(ProvenanceSchema),
    confidence: confidenceSchema.refine((value) => value.level === 'DERIVED', {
      message: 'SemanticObservation confidence level must be DERIVED',
    }),
    id: z.string().regex(SEM_OBS_REF),
  })
  .superRefine((value, ctx) => {
    if (value.based_on.length === 0 && value.provenance.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'SemanticObservation requires based_on >= 1 or provenance >= 1',
        path: ['based_on'],
      });
    }
  });
export type SemanticObservation = z.infer<typeof SemanticObservationSchema>;

export const SemanticAssumptionSchema = z.strictObject({
  type: z.literal('ASSUMPTION'),
  statement: z.string().trim().min(1),
  based_on: z.array(z.string().regex(SEM_OBS_REF)).min(1),
  confidence: confidenceSchema.refine((value) => value.level === 'INFERRED', {
    message: 'SemanticAssumption confidence level must be INFERRED',
  }),
  status: z.enum(ASSUMPTION_STATUSES),
  id: z.string().regex(SEM_ASM_REF),
});
export type SemanticAssumption = z.infer<typeof SemanticAssumptionSchema>;

const SEM_HYP_BASED_ON_REF = /^(?:semobs|semasm):.+/;

export const SemanticHypothesisSchema = z.strictObject({
  type: z.literal('HYPOTHESIS'),
  statement: z.string().trim().min(1),
  based_on: z.array(z.string().regex(SEM_HYP_BASED_ON_REF)).min(1),
  affected_entities: z.array(z.string().regex(ENTITY_REF_PATTERN)),
  required_conditions: z.array(z.string().trim().min(1)),
  status: z.enum(HYPOTHESIS_STATUSES),
  confidence: confidenceSchema.refine((value) => value.level === 'SPECULATIVE', {
    message: 'SemanticHypothesis confidence level must be SPECULATIVE',
  }),
  id: z.string().regex(SEM_HYP_REF),
});
export type SemanticHypothesis = z.infer<typeof SemanticHypothesisSchema>;

export const CandidateInvariantSchema = z.strictObject({
  id: z.string().regex(SEM_INV_REF),
  statement: z.string().trim().min(1),
  invariant_class: z.enum(INVARIANT_CLASSES),
  based_on: z.array(z.string().regex(SEM_EPISTEMIC_REF)).min(1),
  affected_entities: z.array(z.string().regex(ENTITY_REF_PATTERN)),
  status: invariantStatusSchema,
  notes: z.string().trim().min(1).optional(),
});
export type CandidateInvariant = z.infer<typeof CandidateInvariantSchema>;

const countsSchema = z.strictObject({
  transitions: z.number().int().min(0),
  assets: z.number().int().min(0),
  custody: z.number().int().min(0),
  claims: z.number().int().min(0),
  accounting: z.number().int().min(0),
  authority: z.number().int().min(0),
  trust: z.number().int().min(0),
  observations: z.number().int().min(0),
  assumptions: z.number().int().min(0),
  hypotheses: z.number().int().min(0),
  invariants: z.number().int().min(0),
  unknowns: z.number().int().min(0),
});
export type SemanticCounts = z.infer<typeof countsSchema>;

const draftShape = {
  schema_version: z.literal('semantic-model/v1'),
  status: semanticStatusSchema,
  failure: z.strictObject({ code: z.string().min(1), stage: z.string().min(1) }).optional(),
  input: z.strictObject({
    fidelity: z.enum(['semantic', 'syntactic']),
    state_output_hash: z.string().regex(HEX_64_REF),
    file_count: z.number().int().min(0),
    degradation: z.array(z.string().min(1)).optional(),
  }),
  binding: z.strictObject({
    run_id: z.string().min(1).optional(),
    input_manifest_hash: z.string().min(1).optional(),
    scope_hash: z.string().min(1).optional(),
  }),
  contracts: z.array(ContractSemanticsSchema),
  transitions: z.array(StateTransitionSchema),
  assets: z.array(AssetRecordSchema),
  custody: z.array(CustodyRecordSchema),
  claims: z.array(ClaimRecordSchema),
  accounting: z.array(AccountingRelationSchema),
  authority: z.array(AuthorityChainSchema),
  trust: z.strictObject({
    dependencies: z.array(ExternalDependencySchema),
    capabilities: z.array(TrustCapabilitySchema),
  }),
  epistemic: z.strictObject({
    observations: z.array(SemanticObservationSchema),
    assumptions: z.array(SemanticAssumptionSchema),
    hypotheses: z.array(SemanticHypothesisSchema),
    invariants: z.array(CandidateInvariantSchema),
  }),
  unknowns: z.array(UnknownIndexEntrySchema),
} as const;

function failureExclusivity(
  value: { status: SemanticStatus; failure?: { code: string; stage: string } | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.status === 'FAILED' && value.failure === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: "status 'FAILED' requires failure",
      path: ['failure'],
    });
  }
  if (value.status !== 'FAILED' && value.failure !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'failure is only allowed when status is FAILED',
      path: ['failure'],
    });
  }
}

export const SemanticDraftSchema = z.strictObject(draftShape).superRefine(failureExclusivity);
export type SemanticDraft = z.infer<typeof SemanticDraftSchema>;

export const SemanticModelSchema = z
  .strictObject({
    ...draftShape,
    counts: countsSchema,
    semantic_hash: z.string().regex(HEX_64_REF),
  })
  .superRefine(failureExclusivity);
export type SemanticModel = z.infer<typeof SemanticModelSchema>;
