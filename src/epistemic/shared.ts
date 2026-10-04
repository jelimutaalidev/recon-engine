import { ReconError } from '../errors/errors.js';

export function assertNonEmptyBasis(based_on: readonly string[], entity: string): void {
  if (based_on.length === 0) {
    throw new ReconError(
      'InvalidEpistemicDependency',
      `${entity} requires at least one based_on reference`,
      { entity },
    );
  }
}
