export type ReconErrorCode =
  | 'SchemaValidationFailed'
  | 'InvalidIdentifier'
  | 'InvalidRelationshipSource'
  | 'InvalidRelationshipTarget'
  | 'UnsupportedRelationshipType'
  | 'MissingProvenance'
  | 'InvalidProvenance'
  | 'InvalidEpistemicDependency'
  | 'DuplicateCanonicalEntity'
  | 'UnsupportedSchemaVersion'
  | 'InvalidSourceReference'
  | 'InvalidEvidenceReference'
  | 'ConflictingEvidence'
  | 'InvalidConfidence'
  | 'EntityNotFound'
  | 'InvalidReconState'
  | 'MigrationError'
  | 'RootEscape'
  | 'SourceLimitExceeded'
  | 'NoSourcesFound'
  | 'CompilerUnavailable'
  | 'VersionConflict'
  | 'ChecksumMismatch'
  | 'CompilationFailed'
  | 'InvalidScopeReport'
  | 'InvalidSemanticModel';

export interface ReconErrorDetails {
  [key: string]: unknown;
}

export class ReconError extends Error {
  readonly code: ReconErrorCode;
  readonly details: ReconErrorDetails;

  constructor(code: ReconErrorCode, message: string, details: ReconErrorDetails = {}) {
    super(`[${code}] ${message}`);
    this.name = 'ReconError';
    this.code = code;
    this.details = details;
  }
}

export function isReconError(error: unknown): error is ReconError {
  return error instanceof ReconError;
}
