import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDisplayName } from '../core/workspace-name.js';

/**
 * HOW A WORKSPACE IS NAMED: project.json's `name`, else the folder — never the id (beta.7 showed 26 ULIDs). Read once per
 * path. The window's Registry names its workspaces with it, and genie-host its own (the host split, P3.3a), so an agent's
 * address — whose slug is this name — is the same in both, window or not.
 */
const names = new Map<string, string>();

export function workspaceNameFor(path: string): string {
    const cached = names.get(path);
    if (cached !== undefined) return cached;
    let manifest: string | null = null;
    try { manifest = readFileSync(join(path, 'project.json'), 'utf8'); } catch { manifest = null; }
    const name = workspaceDisplayName(manifest, path);
    names.set(path, name);
    return name;
}
