import fs from 'fs';
import path from 'path';

/**
 * Shared config between Genie and the Aionima AGI gateway. Unknown
 * fields are preserved verbatim on write so neither tool clobbers the
 * other's state. See `docs/agi-format.md` for the format contract.
 */

/**
 * A member repo of the envelope. Every member is a git SUBMODULE under
 * `repos/<name>` (path), pinned via gitlink to an exact commit; `branch`
 * records which branch `git submodule update --remote` advances the pin
 * along. Exactly one member is the `host` (the primary repo Aionima
 * containerizes + builds); the rest are `package`s the host consumes via
 * the published npm/composer registry, so nothing in any build config
 * needs rewriting.
 */
export type ProjectJsonRepoRole = 'host' | 'package';

export interface ProjectJsonRepo {
    name: string;
    url?: string;
    /** Checkout path inside the envelope, always `repos/<name>`. */
    path?: string;
    /** 'host' = the primary build target; 'package' = a consumed dependency. */
    role?: ProjectJsonRepoRole;
    /** Tracked branch for `git submodule update --remote`. */
    branch?: string;
}

export interface ProjectJson {
    name?: string;
    createdAt?: string;
    type?: string | null;
    description?: string;
    /**
     * Name of the host repo (the `repos[].name` whose role is 'host').
     * The single source of truth for which member gets built/hosted —
     * `role` on the repo entries mirrors it. Empty/absent = no host yet.
     */
    primaryRepo?: string;
    hosting?: {
        enabled?: boolean;
        hostname?: string;
        mode?: 'development' | 'staging' | 'production';
    };
    repos?: ProjectJsonRepo[];
    // NB: project.json ships inside the monorepo and must NEVER carry a
    // token/secret. Tokens come from the user copying an MCP config — never
    // from here. Don't reintroduce a tynnToken (or any secret) field.
    // Anything else (AGI gateway fields, future Genie fields) is preserved.
    [k: string]: unknown;
}

/**
 * One member's worth of input for building project.json from a convert
 * plan. `isHost` flags the primary; `branch` is the submodule's tracked
 * branch (resolved at convert time, defaulting to 'main').
 */
export interface ProjectJsonRepoInput {
    name: string;
    url: string;
    branch: string;
    isHost: boolean;
}

/**
 * Build the populated project.json for a freshly-converted envelope from
 * its member repos. The host member (exactly one expected) drives
 * `primaryRepo` + `hosting.enabled`; everything else is a `package`. With
 * no members it degrades to the blank shape (empty repos[], hosting off).
 */
export function projectJsonFromRepos(
    name: string,
    slug: string,
    members: ProjectJsonRepoInput[],
): ProjectJson {
    const host = members.find((m) => m.isHost);
    const repos: ProjectJsonRepo[] = members.map((m) => ({
        name: m.name,
        url: m.url,
        path: `repos/${m.name}`,
        role: m.isHost ? 'host' : 'package',
        branch: m.branch,
    }));
    const base = blankProjectJson(name, slug);
    return {
        ...base,
        primaryRepo: host?.name ?? '',
        hosting: {
            ...base.hosting,
            enabled: !!host,
        },
        repos,
    };
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
    };
}
