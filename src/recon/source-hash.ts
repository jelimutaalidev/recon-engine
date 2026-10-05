import { createHash } from 'node:crypto';

export function computeSourceHash(files: readonly { path: string; sha256: string }[]): string {
  return createHash('sha256')
    .update(
      [...files]
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        .map((file) => `${file.path}:${file.sha256}`)
        .join('\n'),
    )
    .digest('hex');
}
