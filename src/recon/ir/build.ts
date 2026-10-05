import type { CompileProjectResult } from '../backend/solc/compile.js';
import { parsePragmas } from '../backend/solc/versions.js';
import type { DiscoveredFile } from '../discover.js';
import { bucketIssue, flushIssues, type IssueBuckets } from '../issue-buckets.js';
import { createReconIssue, type ReconIssue } from '../issues.js';
import { lineMap } from './line-map.js';
import { computeSourceHash } from '../source-hash.js';
import type {
  BaseRef,
  CallKind,
  CallSite,
  ContractIR,
  ContractKind,
  CustomErrorIR,
  CustomErrorUseIR,
  EventEmitIR,
  EventIR,
  FunctionIR,
  FunctionKind,
  ModifierInvocationIR,
  NormalizedProject,
  ParamIR,
  SourceFile,
  Span,
  StateVarIR,
  StateVarMutability,
  StorageAccess,
} from './types.js';

type Ast = Record<string, any>;

type LineFn = (byteOffset: number) => number;

const LOWLEVEL_MEMBERS = new Set(['call', 'delegatecall', 'staticcall', 'send', 'transfer']);

const BUILTIN_CALLS = new Set([
  'require',
  'assert',
  'revert',
  'keccak256',
  'sha256',
  'ripemd160',
  'ecrecover',
  'blockhash',
  'gasleft',
  'addmod',
  'mulmod',
  'selfdestruct',
  'suicide',
  'type',
]);

const ELEMENTARY_ALIASES: Record<string, string> = {
  uint: 'uint256',
  int: 'int256',
  byte: 'bytes1',
  ufixed: 'ufixed128x18',
  fixed: 'fixed128x18',
};

const STATEMENT_TYPES = new Set([
  'Block',
  'Break',
  'Continue',
  'DoWhileStatement',
  'EmitStatement',
  'ExpressionStatement',
  'ForStatement',
  'IfStatement',
  'InlineAssembly',
  'InlineAssemblyStatement',
  'PlaceholderStatement',
  'Return',
  'RevertStatement',
  'TryStatement',
  'VariableDeclarationStatement',
  'WhileStatement',
]);

function asAst(value: unknown): Ast | undefined {
  return typeof value === 'object' && value !== null && 'nodeType' in value ? (value as Ast) : undefined;
}

function astList(value: unknown): Ast[] {
  if (!Array.isArray(value)) return [];
  const out: Ast[] = [];
  for (const item of value) {
    const node = asAst(item);
    if (node !== undefined) out.push(node);
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseSrc(src: unknown): { start: number; length: number } | undefined {
  const text = str(src);
  if (text === undefined) return undefined;
  const parts = text.split(':');
  const start = Number(parts[0]);
  const length = Number(parts[1]);
  if (!Number.isFinite(start) || !Number.isFinite(length)) return undefined;
  return { start, length };
}

function spanOfNode(node: Ast, file: string, line: LineFn): Span {
  const range = parseSrc(node.src);
  if (range === undefined) return { file, byteStart: 0, byteEnd: 0, lineStart: 1, lineEnd: 1 };
  return {
    file,
    byteStart: range.start,
    byteEnd: range.start + range.length,
    lineStart: line(range.start),
    lineEnd: line(range.start + range.length),
  };
}

function typeFromTypeName(value: unknown): string {
  const node = asAst(value);
  if (node === undefined) return '';
  switch (node.nodeType) {
    case 'ElementaryTypeName': {
      const name = str(node.name) ?? '';
      return ELEMENTARY_ALIASES[name] ?? name;
    }
    case 'UserDefinedTypeName':
    case 'IdentifierPath': {
      const path = str(asAst(node.pathNode)?.name) ?? str(node.name) ?? '';
      const segments = path.split('.');
      return segments[segments.length - 1] ?? path;
    }
    case 'Mapping':
      return `mapping(${typeFromTypeName(node.keyType)} => ${typeFromTypeName(node.valueType)})`;
    case 'ArrayTypeName': {
      const base = typeFromTypeName(node.baseType);
      const length = asAst(node.length);
      if (length?.nodeType === 'Literal') return `${base}[${str(length.value) ?? ''}]`;
      return `${base}[]`;
    }
    case 'FunctionTypeName':
      return 'function';
    case 'PayableIdentifierType':
      return 'address';
    default:
      return '';
  }
}

function abiTypeOf(param: Ast, fallback: string): string {
  const typeString = str(param.typeDescriptions?.typeString);
  if (typeString === undefined) return fallback;
  if (
    typeString.startsWith('contract ') ||
    typeString.startsWith('interface ') ||
    typeString.startsWith('library ')
  ) {
    return 'address';
  }
  if (typeString.startsWith('enum ')) return 'uint8';
  if (typeString === 'address payable') return 'address';
  return typeString;
}

function buildParams(
  parameterList: unknown,
  ctx?: BuildContext,
): { params: ParamIR[]; abiTypes: string[] } {
  const list = asAst(parameterList);
  const params: ParamIR[] = [];
  const abiTypes: string[] = [];
  for (const param of astList(list?.parameters)) {
    const name = str(param.name);
    const type = typeFromTypeName(param.typeName);
    params.push(name !== undefined && name.length > 0 ? { name, type } : { type });
    abiTypes.push(ctx !== undefined ? abiTypeOfNode(param, ctx) : abiTypeOf(param, type));
  }
  return { params, abiTypes };
}

function abiTypeOfNode(param: Ast, ctx: BuildContext): string {
  const fallback = str(param.typeDescriptions?.typeString);
  const typeName = asAst(param.typeName);
  if (typeName === undefined) return fallback ?? typeFromTypeName(param.typeName);
  const resolved = abiTypeNode(typeName, ctx);
  return resolved ?? fallback ?? typeFromTypeName(param.typeName);
}

function abiTypeNode(node: Ast, ctx: BuildContext): string | undefined {
  switch (node.nodeType) {
    case 'ElementaryTypeName': {
      const name = typeFromTypeName(node);
      return name === 'address payable' ? 'address' : name.length > 0 ? name : undefined;
    }
    case 'ArrayTypeName': {
      const base = asAst(node.baseType);
      if (base === undefined) return undefined;
      const element = abiTypeNode(base, ctx);
      if (element === undefined) return undefined;
      const length = asAst(node.length);
      if (length?.nodeType === 'Literal') return `${element}[${str(length.value) ?? ''}]`;
      return `${element}[]`;
    }
    case 'UserDefinedTypeName':
    case 'IdentifierPath': {
      const ref =
        num(node.referencedDeclaration) ?? num(asAst(node.pathNode)?.referencedDeclaration);
      const decl = ref === undefined ? undefined : ctx.declById.get(ref);
      if (decl?.nodeType === 'ContractDefinition') return 'address';
      if (decl?.nodeType === 'EnumDefinition') return 'uint8';
      if (decl?.nodeType === 'UserDefinedValueTypeDefinition') {
        const underlying = asAst(decl.underlyingType);
        return underlying === undefined ? undefined : abiTypeNode(underlying, ctx);
      }
      if (decl?.nodeType === 'StructDefinition') {
        const members = astList(decl.members).map((member) => {
          const memberType = asAst(member.typeName);
          return memberType === undefined ? '' : (abiTypeNode(memberType, ctx) ?? '');
        });
        if (members.length === 0 || members.some((member) => member.length === 0)) {
          return undefined;
        }
        return `(${members.join(',')})`;
      }
      return undefined;
    }
    case 'Mapping':
      return undefined;
    default:
      return undefined;
  }
}

function normalizeContractKind(value: string | undefined): ContractKind {
  return value === 'interface' || value === 'library' ? value : 'contract';
}

function normalizeMutability(value: string | undefined): StateVarMutability {
  return value === 'constant' || value === 'immutable' ? value : 'mutable';
}

function normalizeFunctionKind(value: string | undefined): FunctionKind {
  if (value === 'constructor' || value === 'fallback' || value === 'receive') return value;
  return 'function';
}

function sigFor(kind: FunctionKind, name: string, types: readonly string[]): string {
  const joined = types.join(',');
  if (kind === 'constructor') return `constructor(${joined})`;
  if (kind === 'receive') return 'receive()';
  if (kind === 'fallback') return `fallback(${joined})`;
  return `${name}(${joined})`;
}

function fnSignature(decl: Ast): string {
  const name = str(decl.name) ?? '';
  const kind = normalizeFunctionKind(str(decl.kind));
  const { params } = buildParams(decl.parameters);
  return sigFor(kind, name, params.map((param) => param.type));
}

interface Owner {
  file: string;
  contract: string | undefined;
}

function fqnOfOwner(owner: Owner): string {
  return owner.contract === undefined ? owner.file : `${owner.file}:${owner.contract}`;
}

interface BuildContext {
  semantic: boolean;
  contents: Map<string, string>;
  declById: Map<number, Ast>;
  ownerById: Map<number, Owner>;
  contractById: Map<number, { node: Ast; file: string }>;
  output: CompileProjectResult['output'];
  lineCache: Map<string, LineFn>;
  bufferCache: Map<string, Buffer>;
  unsupported: IssueBuckets;
}

const UNSUPPORTED_SPECS = {
  struct: { code: 'unsupported_struct_definition', message: 'struct definitions are not modeled' },
  enum: { code: 'unsupported_enum_definition', message: 'enum definitions are not modeled' },
  udvt: {
    code: 'unsupported_udvt_definition',
    message: 'user-defined value type definitions are not modeled',
  },
  assembly: { code: 'unsupported_assembly', message: 'Yul/assembly bodies are not modeled' },
  tryCatch: { code: 'unsupported_try_catch', message: 'try/catch statements are not modeled' },
  builtin: { code: 'unsupported_builtin', message: 'msg./block./tx. builtins are not modeled' },
} as const;

function unsupportedDefinitionSpec(nodeType: string | undefined):
  | (typeof UNSUPPORTED_SPECS)[keyof Pick<typeof UNSUPPORTED_SPECS, 'struct' | 'enum' | 'udvt'>]
  | undefined {
  if (nodeType === 'StructDefinition') return UNSUPPORTED_SPECS.struct;
  if (nodeType === 'EnumDefinition') return UNSUPPORTED_SPECS.enum;
  if (nodeType === 'UserDefinedValueTypeDefinition') return UNSUPPORTED_SPECS.udvt;
  return undefined;
}

function reportUnsupported(
  ctx: BuildContext,
  spec: { code: string; message: string },
  file: string,
  line: LineFn,
  node: Ast,
): void {
  bucketIssue(ctx.unsupported, spec, spanOfNode(node, file, line));
}

function lineFor(file: string, ctx: BuildContext): LineFn {
  const cached = ctx.lineCache.get(file);
  if (cached !== undefined) return cached;
  const fn = lineMap(bufferFor(file, ctx));
  ctx.lineCache.set(file, fn);
  return fn;
}

function bufferFor(file: string, ctx: BuildContext): Buffer {
  const cached = ctx.bufferCache.get(file);
  if (cached !== undefined) return cached;
  const buffer = Buffer.from(ctx.contents.get(file) ?? '', 'utf8');
  ctx.bufferCache.set(file, buffer);
  return buffer;
}

function indexUnit(unit: Ast, file: string, ctx: BuildContext): void {
  const visit = (node: Ast, contract: string | undefined): void => {
    const scope = node.nodeType === 'ContractDefinition' ? (str(node.name) ?? contract) : contract;
    const id = num(node.id);
    if (id !== undefined) {
      ctx.declById.set(id, node);
      ctx.ownerById.set(id, { file, contract: scope });
      if (node.nodeType === 'ContractDefinition') ctx.contractById.set(id, { node, file });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const child = asAst(item);
          if (child !== undefined) visit(child, scope);
        }
      } else {
        const child = asAst(value);
        if (child !== undefined) visit(child, scope);
      }
    }
  };
  visit(unit, undefined);
}

function resolvedFunctionRef(id: number, decl: Ast, ctx: BuildContext): CallSite['resolvedRef'] {
  const owner = ctx.ownerById.get(id);
  if (owner === undefined) return undefined;
  return { fqn: fqnOfOwner(owner), signature: fnSignature(decl), nodeType: 'FunctionDefinition' };
}

interface BodyEnv {
  ctx: BuildContext;
  file: string;
  line: LineFn;
  stateVarNames: Set<string>;
}

interface BodyOut {
  callSites: CallSite[];
  storageAccesses: StorageAccess[];
  eventEmits: EventEmitIR[];
  customErrorUses: CustomErrorUseIR[];
}

function spanIn(node: Ast, env: BodyEnv): Span {
  return spanOfNode(node, env.file, env.line);
}

function recordStorageTarget(
  identifier: Ast,
  op: StorageAccess['op'],
  out: BodyOut,
  env: BodyEnv,
): void {
  const span = spanIn(identifier, env);
  if (env.ctx.semantic) {
    const ref = num(identifier.referencedDeclaration);
    const decl = ref === undefined ? undefined : env.ctx.declById.get(ref);
    if (decl?.nodeType !== 'VariableDeclaration' || decl.stateVariable !== true) return;
    const owner = ref === undefined ? undefined : env.ctx.ownerById.get(ref);
    if (owner === undefined) return;
    out.storageAccesses.push({
      op,
      resolvedRef: { fqn: fqnOfOwner(owner), name: str(decl.name) ?? '' },
      span,
    });
    return;
  }
  const name = str(identifier.name) ?? '';
  if (!env.stateVarNames.has(name)) return;
  out.storageAccesses.push({ op, span });
}

function collectTargets(node: Ast | undefined, out: Ast[]): void {
  if (node === undefined) return;
  switch (node.nodeType) {
    case 'TupleExpression':
      for (const component of astList(node.components)) collectTargets(component, out);
      return;
    case 'IndexAccess':
      collectTargets(asAst(node.baseExpression), out);
      return;
    case 'MemberAccess':
      collectTargets(asAst(node.expression), out);
      return;
    case 'Identifier':
      out.push(node);
      return;
    default:
      return;
  }
}

function walkLhsDecorations(
  node: Ast | undefined,
  out: BodyOut,
  env: BodyEnv,
): void {
  if (node === undefined) return;
  switch (node.nodeType) {
    case 'TupleExpression':
      for (const component of astList(node.components)) walkLhsDecorations(component, out, env);
      return;
    case 'IndexAccess':
      walkLhsDecorations(asAst(node.baseExpression), out, env);
      walkExpr(node.indexExpression, out, env);
      return;
    case 'MemberAccess':
      walkLhsDecorations(asAst(node.expression), out, env);
      return;
    default:
      return;
  }
}

function isTypeDefinition(decl: Ast | undefined): boolean {
  return (
    decl?.nodeType === 'ContractDefinition' ||
    decl?.nodeType === 'StructDefinition' ||
    decl?.nodeType === 'EnumDefinition' ||
    decl?.nodeType === 'UserDefinedValueTypeDefinition'
  );
}

function recordIdentifierCall(identifier: Ast, span: Span, out: BodyOut, env: BodyEnv): void {
  const name = str(identifier.name) ?? '';
  if (BUILTIN_CALLS.has(name)) return;
  const ref = num(identifier.referencedDeclaration);
  const decl = ref === undefined ? undefined : env.ctx.declById.get(ref);
  if (isTypeDefinition(decl)) return;
  if (!env.ctx.semantic) {
    out.callSites.push({ kind: 'internal', span });
    return;
  }
  if (decl?.nodeType === 'FunctionDefinition' && ref !== undefined) {
    const resolvedRef = resolvedFunctionRef(ref, decl, env.ctx);
    out.callSites.push({
      kind: 'internal',
      ...(resolvedRef !== undefined ? { resolvedRef } : {}),
      span,
    });
    return;
  }
  if (decl?.nodeType === 'VariableDeclaration') {
    out.callSites.push({ kind: 'indirect', span });
    return;
  }
  if (decl?.nodeType === 'EventDefinition' || decl?.nodeType === 'ErrorDefinition') return;
  out.callSites.push({ kind: 'internal', span });
}

function recordMemberCall(member: Ast, span: Span, out: BodyOut, env: BodyEnv): void {
  const memberName = str(member.memberName) ?? '';
  const base = asAst(member.expression);
  const baseName = base?.nodeType === 'Identifier' ? str(base.name) : undefined;
  const ref = num(member.referencedDeclaration);
  const decl = ref === undefined ? undefined : env.ctx.declById.get(ref);

  if (baseName === 'super' || baseName === 'this') {
    const resolvedRef =
      decl?.nodeType === 'FunctionDefinition' && ref !== undefined
        ? resolvedFunctionRef(ref, decl, env.ctx)
        : undefined;
    out.callSites.push({
      kind: baseName === 'super' ? 'super' : 'self-external',
      ...(resolvedRef !== undefined ? { resolvedRef } : {}),
      span,
    });
    return;
  }
  if (baseName === 'abi') return;
  if (LOWLEVEL_MEMBERS.has(memberName)) {
    const baseType = str(asAst(base?.typeDescriptions)?.typeString);
    const addressShaped =
      !env.ctx.semantic || baseType === undefined || baseType.startsWith('address');
    if (addressShaped) {
      const kind: CallKind =
        memberName === 'delegatecall'
          ? 'delegatecall'
          : memberName === 'staticcall'
            ? 'staticcall'
            : 'lowlevel';
      out.callSites.push({ kind, span });
      return;
    }
  }
  const resolvedRef =
    decl?.nodeType === 'FunctionDefinition' && ref !== undefined
      ? resolvedFunctionRef(ref, decl, env.ctx)
      : undefined;
  const visibility = decl?.nodeType === 'FunctionDefinition' ? str(decl.visibility) : undefined;
  const kind: CallKind =
    visibility === 'internal' || visibility === 'private' ? 'internal' : 'external';
  out.callSites.push({
    kind,
    ...(resolvedRef !== undefined ? { resolvedRef } : {}),
    span,
  });
}

function recordNew(target: Ast, span: Span, out: BodyOut, env: BodyEnv): void {
  const typeName = asAst(target.typeName);
  const ref =
    num(typeName?.referencedDeclaration) ?? num(asAst(typeName?.pathNode)?.referencedDeclaration);
  const contract = ref === undefined ? undefined : env.ctx.contractById.get(ref);
  let resolvedRef: CallSite['resolvedRef'];
  if (contract !== undefined) {
    const constructor = astList(contract.node.nodes).find(
      (node) => node.nodeType === 'FunctionDefinition' && node.kind === 'constructor',
    );
    resolvedRef = {
      fqn: `${contract.file}:${str(contract.node.name) ?? ''}`,
      signature: constructor !== undefined ? fnSignature(constructor) : 'constructor()',
      nodeType: 'FunctionDefinition',
    };
  }
  out.callSites.push({
    kind: 'new',
    ...(resolvedRef !== undefined ? { resolvedRef } : {}),
    span,
  });
}

function walkFunctionCall(node: Ast, out: BodyOut, env: BodyEnv): void {
  let callee = asAst(node.expression);
  let options: Ast | undefined;
  if (callee?.nodeType === 'FunctionCallOptions') {
    options = callee;
    callee = asAst(callee.expression);
  }
  const span = spanIn(node, env);
  if (callee !== undefined) {
    if (callee.nodeType === 'NewExpression') {
      recordNew(callee, span, out, env);
    } else if (callee.nodeType === 'Identifier') {
      recordIdentifierCall(callee, span, out, env);
    } else if (callee.nodeType === 'MemberAccess') {
      recordMemberCall(callee, span, out, env);
      walkExpr(callee.expression, out, env);
    }
  }
  if (options !== undefined) {
    const optionValues = asAst(options.options);
    if (optionValues !== undefined) {
      for (const value of Object.values(optionValues)) walkExpr(value, out, env);
    }
  }
  for (const argument of astList(node.arguments)) walkExpr(argument, out, env);
}

function walkAssignment(node: Ast, out: BodyOut, env: BodyEnv): void {
  const lhs = asAst(node.leftHandSide);
  const compound = str(node.operator) !== '=';
  const targets: Ast[] = [];
  collectTargets(lhs, targets);
  for (const target of targets) {
    recordStorageTarget(target, compound ? 'readwrite' : 'write', out, env);
  }
  walkLhsDecorations(lhs, out, env);
  walkExpr(node.rightHandSide, out, env);
}

function walkUnary(node: Ast, out: BodyOut, env: BodyEnv): void {
  const operator = str(node.operator);
  const sub = asAst(node.subExpression);
  if (operator === 'delete' || operator === '++' || operator === '--') {
    const targets: Ast[] = [];
    collectTargets(sub, targets);
    const op: StorageAccess['op'] = operator === 'delete' ? 'write' : 'readwrite';
    for (const target of targets) recordStorageTarget(target, op, out, env);
    walkLhsDecorations(sub, out, env);
    return;
  }
  walkExpr(node.subExpression, out, env);
}

function walkExpr(value: unknown, out: BodyOut, env: BodyEnv): void {
  const node = asAst(value);
  if (node === undefined) return;
  switch (node.nodeType) {
    case 'FunctionCall':
      walkFunctionCall(node, out, env);
      return;
    case 'Assignment':
      walkAssignment(node, out, env);
      return;
    case 'UnaryOperation':
      walkUnary(node, out, env);
      return;
    case 'BinaryOperation':
      walkExpr(node.leftExpression, out, env);
      walkExpr(node.rightExpression, out, env);
      return;
    case 'ConditionalExpression':
      walkExpr(node.condition, out, env);
      walkExpr(node.trueExpression, out, env);
      walkExpr(node.falseExpression, out, env);
      return;
    case 'TupleExpression':
      for (const component of astList(node.components)) walkExpr(component, out, env);
      return;
    case 'IndexAccess':
      walkExpr(node.baseExpression, out, env);
      walkExpr(node.indexExpression, out, env);
      return;
    case 'MemberAccess': {
      const base = asAst(node.expression);
      const baseName = base?.nodeType === 'Identifier' ? str(base.name) : undefined;
      if (baseName === 'msg' || baseName === 'block' || baseName === 'tx') {
        reportUnsupported(env.ctx, UNSUPPORTED_SPECS.builtin, env.file, env.line, node);
      }
      walkExpr(node.expression, out, env);
      return;
    }
    case 'Identifier':
      recordStorageTarget(node, 'read', out, env);
      return;
    case 'NewExpression':
      recordNew(node, spanIn(node, env), out, env);
      return;
    case 'Literal':
    case 'ElementaryTypeNameExpression':
      return;
    default:
      walkChildren(node, out, env);
      return;
  }
}

function walkChildren(node: Ast, out: BodyOut, env: BodyEnv): void {
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) routeNode(item, out, env);
    } else {
      routeNode(value, out, env);
    }
  }
}

function routeNode(value: unknown, out: BodyOut, env: BodyEnv): void {
  const node = asAst(value);
  if (node === undefined) return;
  if (STATEMENT_TYPES.has(node.nodeType)) walkStatement(node, out, env);
  else walkExpr(node, out, env);
}

function walkEmitStatement(node: Ast, out: BodyOut, env: BodyEnv): void {
  const call = asAst(node.eventCall);
  const callee = asAst(call?.expression);
  const ref = num(callee?.referencedDeclaration);
  const decl = ref === undefined ? undefined : env.ctx.declById.get(ref);
  const signature =
    env.ctx.semantic && decl?.nodeType === 'EventDefinition' ? fnSignature(decl) : undefined;
  out.eventEmits.push({ signature, span: spanIn(node, env) });
  for (const argument of astList(call?.arguments)) walkExpr(argument, out, env);
}

function walkRevertStatement(node: Ast, out: BodyOut, env: BodyEnv): void {
  const call = asAst(node.errorCall);
  const callee = asAst(call?.expression);
  const name = str(callee?.name) ?? '';
  if (!BUILTIN_CALLS.has(name)) {
    const ref = num(callee?.referencedDeclaration);
    const decl = ref === undefined ? undefined : env.ctx.declById.get(ref);
    const signature =
      env.ctx.semantic && decl?.nodeType === 'ErrorDefinition' ? fnSignature(decl) : undefined;
    out.customErrorUses.push({ signature, span: spanIn(node, env) });
  }
  for (const argument of astList(call?.arguments)) walkExpr(argument, out, env);
}

function walkStatement(value: unknown, out: BodyOut, env: BodyEnv): void {
  const node = asAst(value);
  if (node === undefined) return;
  switch (node.nodeType) {
    case 'Block':
      for (const statement of astList(node.statements)) walkStatement(statement, out, env);
      return;
    case 'ExpressionStatement':
      walkExpr(node.expression, out, env);
      return;
    case 'VariableDeclarationStatement':
      walkExpr(node.initialValue, out, env);
      return;
    case 'Return':
      walkExpr(node.expression, out, env);
      return;
    case 'IfStatement':
      walkExpr(node.condition, out, env);
      walkStatement(node.trueBody, out, env);
      walkStatement(node.falseBody, out, env);
      return;
    case 'WhileStatement':
      walkExpr(node.condition, out, env);
      walkStatement(node.body, out, env);
      return;
    case 'DoWhileStatement':
      walkStatement(node.body, out, env);
      walkExpr(node.condition, out, env);
      return;
    case 'ForStatement':
      walkStatement(node.initializationExpression, out, env);
      walkExpr(node.condition, out, env);
      walkStatement(node.loopExpression, out, env);
      walkStatement(node.body, out, env);
      return;
    case 'EmitStatement':
      walkEmitStatement(node, out, env);
      return;
    case 'RevertStatement':
      walkRevertStatement(node, out, env);
      return;
    case 'TryStatement': {
      reportUnsupported(env.ctx, UNSUPPORTED_SPECS.tryCatch, env.file, env.line, node);
      walkExpr(node.expression, out, env);
      for (const clause of astList(node.clauses)) {
        const block = asAst(clause.block);
        if (block !== undefined) walkStatement(block, out, env);
      }
      return;
    }
    case 'InlineAssembly':
    case 'InlineAssemblyStatement':
      reportUnsupported(env.ctx, UNSUPPORTED_SPECS.assembly, env.file, env.line, node);
      return;
    case 'Break':
    case 'Continue':
    case 'PlaceholderStatement':
      return;
    default:
      walkChildren(node, out, env);
      return;
  }
}

function storageLayoutFor(
  ctx: BuildContext,
  file: string,
  contractName: string,
): Map<number, string> | undefined {
  const entries = ctx.output.contracts?.[file]?.[contractName]?.storageLayout?.storage;
  if (entries === undefined) return undefined;
  const layout = new Map<number, string>();
  for (const entry of entries) {
    const id = num(entry.astId);
    const slot = str(entry.slot);
    if (id !== undefined && slot !== undefined) layout.set(id, slot);
  }
  return layout;
}

function methodIdentifiersFor(
  ctx: BuildContext,
  file: string,
  contractName: string,
): Record<string, string> | undefined {
  return ctx.output.contracts?.[file]?.[contractName]?.evm?.methodIdentifiers;
}

function buildStateVariable(
  node: Ast,
  declaredIn: string,
  layout: Map<number, string> | undefined,
  file: string,
  line: LineFn,
): StateVarIR {
  const slot = layout !== undefined ? layout.get(num(node.id) ?? -1) : undefined;
  return {
    name: str(node.name) ?? '',
    type: typeFromTypeName(node.typeName),
    visibility: str(node.visibility) ?? '',
    mutability: normalizeMutability(str(node.mutability)),
    ...(slot !== undefined ? { slot } : {}),
    declaredIn,
    span: spanOfNode(node, file, line),
  };
}

function buildModifiers(list: Ast[], content: Buffer): ModifierInvocationIR[] {
  const out: ModifierInvocationIR[] = [];
  for (const invocation of list) {
    const nameNode = asAst(invocation.modifierName);
    const name = str(nameNode?.name) ?? '';
    const args = astList(invocation.arguments);
    let argsText = '';
    if (args.length > 0) {
      const first = parseSrc(args[0]?.src);
      const last = parseSrc(args[args.length - 1]?.src);
      if (first !== undefined && last !== undefined) {
        argsText = content.subarray(first.start, last.start + last.length).toString('utf8');
      }
    }
    out.push({ name, argsText });
  }
  return out;
}

interface FunctionEnv {
  ctx: BuildContext;
  file: string;
  line: LineFn;
  contractFqn: string;
  contractName: string;
  stateVarNames: Set<string>;
}

function buildFunction(node: Ast, env: FunctionEnv): FunctionIR {
  const name = str(node.name) ?? '';
  const kind = normalizeFunctionKind(str(node.kind));
  const { params, abiTypes } = buildParams(node.parameters, env.ctx);
  const { params: returns } = buildParams(node.returnParameters, env.ctx);
  const content = bufferFor(env.file, env.ctx);
  const modifiers = buildModifiers(astList(node.modifiers), content);
  const canonicalSignature = sigFor(kind, name, params.map((param) => param.type));
  let selector: string | undefined;
  let methodIdentifier: string | undefined;
  if (env.ctx.semantic) {
    const methods = methodIdentifiersFor(env.ctx, env.file, env.contractName);
    if (methods !== undefined) {
      const abiSignature = sigFor(kind, name, abiTypes);
      if (methods[canonicalSignature] !== undefined) {
        methodIdentifier = canonicalSignature;
        selector = methods[canonicalSignature];
      } else if (abiSignature !== canonicalSignature && methods[abiSignature] !== undefined) {
        methodIdentifier = abiSignature;
        selector = methods[abiSignature];
      }
    }
  }
  const bodyEnv: BodyEnv = {
    ctx: env.ctx,
    file: env.file,
    line: env.line,
    stateVarNames: env.stateVarNames,
  };
  const out: BodyOut = {
    callSites: [],
    storageAccesses: [],
    eventEmits: [],
    customErrorUses: [],
  };
  const body = asAst(node.body);
  if (body !== undefined) walkStatement(body, out, bodyEnv);
  return {
    kind,
    name,
    params,
    returns,
    visibility: str(node.visibility) ?? '',
    stateMutability: str(node.stateMutability) ?? '',
    modifiers,
    canonicalSignature,
    ...(selector !== undefined ? { selector } : {}),
    ...(methodIdentifier !== undefined ? { methodIdentifier } : {}),
    declaredIn: env.contractFqn,
    span: spanOfNode(node, env.file, env.line),
    implemented: bool(node.implemented) ?? body !== undefined,
    callSites: out.callSites,
    storageAccesses: out.storageAccesses,
    eventEmits: out.eventEmits,
    customErrorUses: out.customErrorUses,
  };
}

function buildContract(node: Ast, file: string, ctx: BuildContext): ContractIR {
  const name = str(node.name) ?? '';
  const fqn = `${file}:${name}`;
  const line = lineFor(file, ctx);
  const bases: BaseRef[] = [];
  if (ctx.semantic) {
    const linearized = Array.isArray(node.linearizedBaseContracts)
      ? node.linearizedBaseContracts.map((value: unknown) => num(value))
      : [];
    for (const id of linearized) {
      if (id === undefined) continue;
      const target = ctx.contractById.get(id);
      const owner = ctx.ownerById.get(id);
      if (target === undefined || owner === undefined) continue;
      bases.push({
        fqn: fqnOfOwner(owner),
        kind: normalizeContractKind(str(target.node.contractKind)),
      });
    }
  }
  const stateVarNames = new Set<string>();
  const stateVars: StateVarIR[] = [];
  const events: EventIR[] = [];
  const customErrors: CustomErrorIR[] = [];
  const functions: FunctionIR[] = [];
  const members = astList(node.nodes);
  const layout = ctx.semantic ? storageLayoutFor(ctx, file, name) : undefined;
  for (const member of members) {
    if (member.nodeType === 'VariableDeclaration') {
      const varName = str(member.name) ?? '';
      stateVarNames.add(varName);
      stateVars.push(buildStateVariable(member, fqn, layout, file, line));
    }
  }
  for (const member of members) {
    if (member.nodeType === 'EventDefinition') {
      const { params } = buildParams(member.parameters);
      events.push({
        name: str(member.name) ?? '',
        params,
        canonicalSignature: fnSignature(member),
        span: spanOfNode(member, file, line),
      });
    } else if (member.nodeType === 'ErrorDefinition') {
      const { params } = buildParams(member.parameters);
      customErrors.push({
        name: str(member.name) ?? '',
        params,
        canonicalSignature: fnSignature(member),
        span: spanOfNode(member, file, line),
      });
    } else {
      const spec = unsupportedDefinitionSpec(member.nodeType);
      if (spec !== undefined) reportUnsupported(ctx, spec, file, line, member);
    }
  }
  for (const member of members) {
    if (member.nodeType === 'FunctionDefinition') {
      functions.push(
        buildFunction(member, {
          ctx,
          file,
          line,
          contractFqn: fqn,
          contractName: name,
          stateVarNames,
        }),
      );
    }
  }
  return {
    kind: normalizeContractKind(str(node.contractKind)),
    abstract: bool(node.abstract) ?? false,
    name,
    fqn,
    span: spanOfNode(node, file, line),
    bases,
    stateVars,
    functions,
    events,
    customErrors,
  };
}

export function buildIr(
  result: CompileProjectResult,
  files: readonly DiscoveredFile[],
): { ir: NormalizedProject; issues: ReconIssue[] } {
  const issues: ReconIssue[] = [];
  const ctx: BuildContext = {
    semantic: result.fidelity === 'semantic',
    contents: result.contents,
    declById: new Map(),
    ownerById: new Map(),
    contractById: new Map(),
    output: result.output,
    lineCache: new Map(),
    bufferCache: new Map(),
    unsupported: new Map(),
  };
  const sources = result.output.sources ?? {};
  for (const [path, entry] of Object.entries(sources)) {
    const unit = asAst(entry?.ast);
    if (unit !== undefined) indexUnit(unit, path, ctx);
  }

  const sourceFiles: SourceFile[] = files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    pragmas: parsePragmas(ctx.contents.get(file.path) ?? ''),
  }));

  const contracts: ContractIR[] = [];
  const fileLevelErrors: CustomErrorIR[] = [];
  for (const [path, entry] of Object.entries(sources)) {
    const unit = asAst(entry?.ast);
    if (unit === undefined) continue;
    const line = lineFor(path, ctx);
    for (const child of astList(unit.nodes)) {
      if (child.nodeType === 'ContractDefinition') {
        contracts.push(buildContract(child, path, ctx));
      } else if (child.nodeType === 'ErrorDefinition') {
        fileLevelErrors.push({
          name: str(child.name) ?? '',
          params: buildParams(child.parameters).params,
          canonicalSignature: fnSignature(child),
          span: spanOfNode(child, path, line),
        });
      } else {
        const spec = unsupportedDefinitionSpec(child.nodeType);
        if (spec !== undefined) reportUnsupported(ctx, spec, path, line, child);
      }
    }
  }

  issues.push(...flushIssues(ctx.unsupported, 'UNSUPPORTED'));

  const sourceHash = computeSourceHash(files);
  const ir: NormalizedProject = {
    fidelity: result.fidelity,
    compiler: { longVersion: result.longVersion, sourceHash },
    files: sourceFiles,
    contracts,
    fileLevelErrors,
    issues,
  };
  return { ir, issues };
}
