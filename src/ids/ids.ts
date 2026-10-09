import { createHash } from 'node:crypto';
import { stableStringify } from '../util/canonical.js';
import { ReconError } from '../errors/errors.js';
import { normalizeAddress, normalizeChainId, normalizeName, normalizeSourceFile } from './normalize.js';

export type ContentIdPrefix =
  | 'fact'
  | 'obs'
  | 'asm'
  | 'hyp'
  | 'evidence'
  | 'rel'
  | 'prov'
  | 'run'
  | 'issue';

export interface AddressIdentity {
  chainId?: string | undefined;
  address?: string | undefined;
  name?: string | undefined;
}

export function projectId(name: string): string {
  return `project:${normalizeName(name)}`;
}

export function contractId(identity: AddressIdentity): string {
  return addressScopedId('contract', identity);
}

export function sourceContractId(sourceFile: string, name: string): string {
  return `contract:${normalizeSourceFile(sourceFile)}:${normalizeName(name).toLowerCase()}`;
}

export function functionId(contractIdValue: string, signature: string): string {
  return `function:${contractIdValue}:${signature}`;
}

export function stateVariableId(contractIdValue: string, name: string): string {
  return `state:${contractIdValue}:${normalizeName(name)}`;
}

export function assetId(identity: AddressIdentity): string {
  return addressScopedId('asset', identity);
}

export function roleId(contractIdValue: string | undefined, name: string): string {
  const normalized = normalizeName(name);
  return contractIdValue === undefined
    ? `role:${normalized}`
    : `role:${contractIdValue}:${normalized}`;
}

export function dependencyId(identity: AddressIdentity): string {
  return addressScopedId('dependency', identity);
}

export function provenanceId(payload: unknown): string {
  return contentId('prov', payload);
}

export interface IssueIdentityInput {
  severity: string;
  code: string;
  file?: string | undefined;
  line_start?: number | undefined;
  line_end?: number | undefined;
}

const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:)/;

export function normalizeIssueFile(path: string): string {
  const posix = path.trim().replace(/\\/g, '/');
  const segments = posix.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  const normalized = segments.join('/');
  if (ABSOLUTE_PATH_PATTERN.test(posix) || posix.startsWith('//')) {
    throw new ReconError('InvalidIdentifier', 'issue file path must be project-relative', {
      path,
    });
  }
  return normalized;
}

export function issueContentId(input: IssueIdentityInput): string {
  const payload: Record<string, string | number> = {
    severity: input.severity,
    code: input.code,
  };
  if (input.file !== undefined) payload['file'] = normalizeIssueFile(input.file);
  if (input.line_start !== undefined) payload['line_start'] = input.line_start;
  if (input.line_end !== undefined) payload['line_end'] = input.line_end;
  return contentId('issue', payload);
}

export function contentId(prefix: ContentIdPrefix, payload: unknown): string {
  const digest = createHash('sha256').update(stableStringify(payload)).digest('hex');
  return `${prefix}:${digest.slice(0, 16)}`;
}

function addressScopedId(prefix: 'contract' | 'asset' | 'dependency', identity: AddressIdentity): string {
  if (identity.address !== undefined && identity.address.length > 0) {
    if (identity.chainId === undefined || identity.chainId.trim().length === 0) {
      throw new Error('chainId is required when an address is present');
    }
    return `${prefix}:${normalizeChainId(identity.chainId)}:${normalizeAddress(identity.address)}`;
  }
  if (identity.name === undefined || identity.name.trim().length === 0) {
    throw new Error('name is required when no address is present');
  }
  return `${prefix}:${normalizeName(identity.name)}`;
}
