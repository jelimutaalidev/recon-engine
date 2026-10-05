import type { ReconIssue } from '../issues.js';

export interface Span {
  file: string;
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
}

export interface SourceFile {
  path: string;
  sha256: string;
  pragmas: string[];
}

export type ContractKind = 'contract' | 'interface' | 'library';

export interface BaseRef {
  fqn: string;
  kind: ContractKind | 'unknown';
}

export interface ParamIR {
  name?: string;
  type: string;
}

export interface ModifierInvocationIR {
  name: string;
  argsText: string;
}

export type FunctionKind = 'function' | 'constructor' | 'fallback' | 'receive';

export type CallKind =
  | 'internal'
  | 'external'
  | 'super'
  | 'self-external'
  | 'new'
  | 'delegatecall'
  | 'staticcall'
  | 'lowlevel'
  | 'indirect';

export interface CallSite {
  kind: CallKind;
  resolvedRef?: { fqn: string; signature: string; nodeType: string };
  span: Span;
}

export interface StorageAccess {
  op: 'read' | 'write' | 'readwrite';
  resolvedRef?: { fqn: string; name: string };
  span: Span;
}

export interface EventEmitIR {
  signature?: string;
  span: Span;
}

export interface CustomErrorUseIR {
  signature?: string;
  span: Span;
}

export interface FunctionIR {
  kind: FunctionKind;
  name: string;
  params: ParamIR[];
  returns: ParamIR[];
  visibility: string;
  stateMutability: string;
  modifiers: ModifierInvocationIR[];
  canonicalSignature: string;
  selector?: string;
  methodIdentifier?: string;
  declaredIn: string;
  span: Span;
  implemented: boolean;
  callSites: CallSite[];
  storageAccesses: StorageAccess[];
  eventEmits: EventEmitIR[];
  customErrorUses: CustomErrorUseIR[];
}

export type StateVarMutability = 'mutable' | 'constant' | 'immutable';

export interface StateVarIR {
  name: string;
  type: string;
  visibility: string;
  mutability: StateVarMutability;
  slot?: string;
  declaredIn: string;
  span: Span;
}

export interface EventIR {
  name: string;
  params: ParamIR[];
  canonicalSignature: string;
  span: Span;
}

export interface CustomErrorIR {
  name: string;
  params: ParamIR[];
  canonicalSignature: string;
  span: Span;
}

export interface ContractIR {
  kind: ContractKind;
  abstract: boolean;
  name: string;
  fqn: string;
  span: Span;
  bases: BaseRef[];
  stateVars: StateVarIR[];
  functions: FunctionIR[];
  events: EventIR[];
  customErrors: CustomErrorIR[];
}

export interface NormalizedProject {
  fidelity: 'semantic' | 'syntactic';
  compiler?: { longVersion: string };
  files: SourceFile[];
  contracts: ContractIR[];
  fileLevelErrors: CustomErrorIR[];
  issues: ReconIssue[];
}
