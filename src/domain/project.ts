import { z } from 'zod';
import { projectId } from '../ids/ids.js';
import { parseOrThrow } from './helpers.js';

const ProjectShape = {
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  chains: z
    .array(z.string().trim().toLowerCase().min(1))
    .transform((chains) => [...new Set(chains)].sort())
    .default([]),
  repository: z.string().trim().min(1).optional(),
  commit: z.string().trim().min(1).optional(),
  version: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
} as const;

const ProjectInputSchema = z.strictObject(ProjectShape);

export const ProjectSchema = z.strictObject({
  id: z.string().regex(/^project:.+$/),
  ...ProjectShape,
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
  updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
});

export type ProjectInput = z.input<typeof ProjectInputSchema>;
export type Project = z.infer<typeof ProjectSchema>;

export function createProject(input: ProjectInput): Project {
  const parsed = parseOrThrow(ProjectInputSchema, input, 'Project');
  const now = new Date().toISOString();
  return parseOrThrow(
    ProjectSchema,
    {
      ...parsed,
      id: projectId(parsed.name),
      created_at: parsed.created_at ?? now,
      updated_at: parsed.updated_at ?? parsed.created_at ?? now,
    },
    'Project',
  );
}
