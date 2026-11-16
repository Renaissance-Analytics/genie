import { resolveRepoDir } from './envelope-sites.js';
import type { LiveModel } from './workspace-save.js';

/**
 * SITES SAVE PORTABLY (Tynn #756, PR4; the design, section 2). A site entry in project.json is shared with every clone, so on
 * its way to the file:
 *
 * - an ABSOLUTE PATH inside the workspace becomes relative to the folder the site runs in (its repo's folder: that is where a
 *   relative token resolves when the command starts). A path outside the workspace is left as it is, so the guard refuses the
 *   save and says how to fix it: there is no portable form of a file that is not in the repo.
 * - a PORT Genie handed out (`--port 8000`, `127.0.0.1:8000`) becomes the `{port}` placeholder, the way Genie fills it at start.
 * - the stored key, `hostPort` (a port the person declared for a server already running), and every other member are kept.
 *
 * Pure. What it did is returned, so the person is told what became what; nothing is rewritten silently.
 */

export interface SiteRewrite {
    /** Where, as a path into project.json: `sites.<key>.command[5]`. */
    readonly path: string;
    readonly from: string;
    readonly to: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const slashes = (p: string): string => p.replace(/\\/g, '/');
const DRIVE = /^[A-Za-z]:\//;
/** The same drive-or-POSIX test the guard uses, anchored to the token (a path with two segments, or under a well-known root). */
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\s\\]|\/(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]|(?:home|Users|usr|opt|var|etc|tmp|mnt|srv|root|proc)\b))/;
/** A loopback or wildcard address with a port, as one token (envelope-sites.ts reads the same form). */
const HOST_PORT = /^((?:\d{1,3}(?:\.\d{1,3}){3}|localhost)?):\d+$/;

/** A path as comparable segments (the drive's case and the rest of a Windows path do not matter; a POSIX path's do). */
function segmentsOf(path: string): { drive: boolean; segments: string[] } {
    const p = slashes(path).replace(/\/+$/, '');
    const drive = DRIVE.test(p);
    return { drive, segments: p.split('/').filter((s, i) => s !== '' || i === 0) };
}

/** The segments of `target` below `root`, or null when it is not inside. */
function below(root: string, target: string): string[] | null {
    const r = segmentsOf(root);
    const t = segmentsOf(target);
    if (t.segments.length < r.segments.length) return null;
    const same = (a: string, b: string) => (r.drive ? a.toLowerCase() === b.toLowerCase() : a === b);
    for (let i = 0; i < r.segments.length; i++) if (!same(r.segments[i]!, t.segments[i]!)) return null;
    return t.segments.slice(r.segments.length);
}

/** `target` as a path from the folder `cwd` (both inside `root`): `./x`, or `../../x` when it climbs. */
function relativeFrom(root: string, cwdRel: readonly string[], target: readonly string[]): string {
    let common = 0;
    while (common < cwdRel.length && common < target.length && cwdRel[common] === target[common]) common++;
    const up = cwdRel.length - common;
    const rest = target.slice(common).join('/');
    if (up > 0) return `${'../'.repeat(up)}${rest}`.replace(/\/$/, '') || '..';
    return rest === '' ? '.' : `./${rest}`;
}

interface Context {
    readonly root: string;
    /** The folder the site runs in, below the workspace (`[]` = the workspace itself). */
    readonly cwd: readonly string[];
}

/** One token's portable form, or null when it is already portable (or cannot be made so). */
function portableToken(token: string, ctx: Context): string | null {
    const eq = /^(--?[A-Za-z][\w-]*)=(.*)$/.exec(token);
    const flag = eq ? `${eq[1]}=` : '';
    const value = eq ? eq[2]! : token;
    if (value.includes('{port}')) return null;
    if (eq && /^(--port|-p)$/.test(eq[1]!) && /^\d+$/.test(value)) return `${flag}{port}`;
    const hp = HOST_PORT.exec(value);
    if (hp) {
        const bind = hp[1] === undefined || hp[1] === '' || hp[1] === '0.0.0.0' ? '127.0.0.1' : hp[1];
        return `${flag}${bind}:{port}`;
    }
    if (ABSOLUTE.test(value)) {
        const inside = below(ctx.root, value);
        return inside === null ? null : `${flag}${relativeFrom(ctx.root, ctx.cwd, inside)}`;
    }
    return null;
}

/** An argv with its ports and in-workspace paths made portable, and what changed. */
function portableArgv(argv: readonly unknown[], ctx: Context, path: string): { argv: unknown[]; rewrites: SiteRewrite[] } {
    const out = [...argv];
    const rewrites: SiteRewrite[] = [];
    for (let i = 0; i < out.length; i++) {
        const token = out[i];
        if (typeof token !== 'string') continue;
        const next = out[i + 1];
        // `--port 8000` / `-p 8000`: the NUMBER is the port.
        if ((token === '--port' || token === '-p') && typeof next === 'string' && /^\d+$/.test(next)) {
            out[i + 1] = '{port}';
            rewrites.push({ path: `${path}[${i + 1}]`, from: next, to: '{port}' });
            i++;
            continue;
        }
        const better = portableToken(token, ctx);
        if (better !== null && better !== token) {
            out[i] = better;
            rewrites.push({ path: `${path}[${i}]`, from: token, to: better });
        }
    }
    return { argv: out, rewrites };
}

function repoListed(manifest: Record<string, unknown>, repo: string): boolean {
    const repos = Array.isArray(manifest.repos) ? manifest.repos.filter(isRecord) : [];
    return repos.some((r) => {
        const path = typeof r.path === 'string' ? slashes(r.path).replace(/^\.\//, '').replace(/\/+$/, '') : null;
        return r.slug === repo || r.name === repo || (path !== null && (path === repo || path.split('/').at(-1) === repo));
    });
}

export function portableSites(manifest: Record<string, unknown>, workspacePath: string): { manifest: Record<string, unknown>; rewrites: SiteRewrite[]; notes: string[] } {
    const rewrites: SiteRewrite[] = [];
    const notes: string[] = [];
    if (!isRecord(manifest.sites)) return { manifest, rewrites, notes };
    const sites: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(manifest.sites)) {
        if (!isRecord(entry)) { sites[key] = entry; continue; }
        const repo = typeof entry.repo === 'string' ? entry.repo : '';
        const repoDir = resolveRepoDir(manifest, repo) ?? '.';
        const ctx: Context = { root: workspacePath, cwd: repoDir === '.' ? [] : repoDir.split('/') };
        let next: Record<string, unknown> = entry;
        for (const member of ['command', 'serve'] as const) {
            const argv = entry[member];
            if (!Array.isArray(argv)) continue;
            const r = portableArgv(argv, ctx, `sites.${key}.${member}`);
            if (r.rewrites.length === 0) continue;
            next = { ...next, [member]: r.argv };
            rewrites.push(...r.rewrites);
        }
        const hostServe = entry.hostServe;
        if (isRecord(hostServe) && typeof hostServe.root === 'string' && ABSOLUTE.test(hostServe.root)) {
            const inside = below(`${workspacePath.replace(/[\\/]+$/, '')}/${ctx.cwd.join('/')}`.replace(/\/$/, ''), hostServe.root);
            if (inside !== null) {
                const to = inside.join('/') || '.';
                next = { ...next, hostServe: { ...hostServe, root: to } };
                rewrites.push({ path: `sites.${key}.hostServe.root`, from: hostServe.root, to });
            }
        }
        sites[key] = next;
        if (repo !== '' && repo !== '.' && !repoListed(manifest, repo)) {
            const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : key;
            notes.push(`Site ${name}: its repo "${repo}" is not in repos[], so a clone has no folder for it.`);
        }
    }
    return { manifest: rewrites.length > 0 ? { ...manifest, sites } : manifest, rewrites, notes };
}

/** The live model with its sites made portable, and what was done told in its notes (shown to the person, never silent). */
export function withPortableSites(model: LiveModel, workspacePath: string): LiveModel {
    const portable = portableSites(model.manifest, workspacePath);
    const told = [...portable.rewrites.map((r) => `${r.path}: ${r.from} saved as ${r.to}`), ...portable.notes];
    if (told.length === 0 && portable.manifest === model.manifest) return model;
    return { ...model, manifest: portable.manifest, notes: [...(model.notes ?? []), ...told] };
}
