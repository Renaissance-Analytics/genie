import type { PlatformPath } from 'node:path';

/** Stub (genie#1347): the failing tests land first; the confinement itself follows. */
export function insideRoot(_root: string, _requested: string, _api?: PlatformPath): string | null {
    throw new Error('insideRoot: not implemented');
}
