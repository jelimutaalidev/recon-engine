import type { ModifierInvocationIR } from '../ir/types.js';

export function modifierText(invocation: ModifierInvocationIR): string {
  const args = invocation.argsText.replace(/\s+/g, ' ').trim();
  return args.length > 0 ? `${invocation.name}(${args})` : invocation.name;
}
