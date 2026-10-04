import { z } from 'zod';
import { parseOrThrow } from '../domain/helpers.js';

export interface ReconLimits {
  maxFileBytes: number;
  maxFiles: number;
  timeoutMs: number;
}

export interface ReconConfig {
  root: string;
  includes: string[];
  excludes: string[];
  compilerSource: 'auto' | 'cache-only';
  remappings: string[];
  recordGit: boolean;
  limits: ReconLimits;
  solcVersion?: string | undefined;
  projectName?: string | undefined;
  repository?: string | undefined;
  timestamp?: string | undefined;
}

const DEFAULT_LIMITS: ReconLimits = {
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 5000,
  timeoutMs: 60_000,
};

const ReconConfigSchema = z.strictObject({
  root: z.string().trim().min(1),
  includes: z.array(z.string().trim().min(1)).default(['**/*.sol']),
  excludes: z.array(z.string().trim().min(1)).default([]),
  compilerSource: z.enum(['auto', 'cache-only']).default('auto'),
  remappings: z.array(z.string()).default([]),
  recordGit: z.boolean().default(true),
  limits: z
    .strictObject({
      maxFileBytes: z.number().int().positive().optional(),
      maxFiles: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  solcVersion: z.string().trim().min(1).optional(),
  projectName: z.string().trim().min(1).optional(),
  repository: z.string().trim().min(1).optional(),
  timestamp: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'timestamp must be a valid ISO-8601 date')
    .optional(),
});

export function parseReconConfig(raw: unknown): ReconConfig {
  const parsed = parseOrThrow(ReconConfigSchema, raw, 'ReconConfig');
  return {
    root: parsed.root,
    includes: parsed.includes,
    excludes: parsed.excludes,
    compilerSource: parsed.compilerSource,
    remappings: parsed.remappings,
    recordGit: parsed.recordGit,
    limits: {
      maxFileBytes: parsed.limits?.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
      maxFiles: parsed.limits?.maxFiles ?? DEFAULT_LIMITS.maxFiles,
      timeoutMs: parsed.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    },
    ...(parsed.solcVersion !== undefined ? { solcVersion: parsed.solcVersion } : {}),
    ...(parsed.projectName !== undefined ? { projectName: parsed.projectName } : {}),
    ...(parsed.repository !== undefined ? { repository: parsed.repository } : {}),
    ...(parsed.timestamp !== undefined ? { timestamp: parsed.timestamp } : {}),
  };
}
