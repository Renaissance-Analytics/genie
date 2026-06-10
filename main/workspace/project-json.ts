import fs from 'fs';
import path from 'path';

/**
 * Shared config between Genie and the Aionima AGI gateway. Unknown
 * fields are preserved verbatim on write so neither tool clobbers the
 * other's state. See `docs/agi-format.md` for the format contract.
 */

export interface ProjectJsonRepo {
    name: string;
    url?: string;
    branch?: string;
}

export interface ProjectJson {
    name?: string;
    createdAt?: string;
    type?: string | null;
    description?: string;
    hosting?: {
        enabled?: boolean;
        hostname?: string;
        mode?: 'development' | 'staging' | 'production';
    };
    repos?: ProjectJsonRepo[];
    tynnToken?: string | null;
    // Anything else (AGI gateway fields, future Genie fields) is preserved.
    [k: string]: unknown;
}

export function readProjectJson(folder: string): ProjectJson | null {
    const file = path.join(folder, 'project.json');
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectJson;
    } catch (e) {
        console.warn('Bad project.json at', file, e);
        return null;
    }
}

export function writeProjectJson(folder: string, patch: ProjectJson): void {
    const file = path.join(folder, 'project.json');
    const existing = readProjectJson(folder) ?? {};
    const merged: ProjectJson = { ...existing, ...patch };

    // Merge nested known objects rather than replacing them outright.
    if (patch.hosting || existing.hosting) {
        merged.hosting = { ...(existing.hosting ?? {}), ...(patch.hosting ?? {}) };
    }

    // Atomic write: temp file → rename.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

export function blankProjectJson(name: string, slug: string): ProjectJson {
    return {
        name,
        createdAt: new Date().toISOString(),
        type: null,
        description: '',
        hosting: {
            enabled: false,
            hostname: '',
            mode: 'development',
        },
        repos: [],
        tynnToken: null,
    };
}
