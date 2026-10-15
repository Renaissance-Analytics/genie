import { createHash } from 'node:crypto';
import { isGenHost, siteNameProblem } from './gen-name.js';

/**
 * A WORKSPACE'S SITES, AS ITS ENVELOPE DECLARES THEM (§6.6) — the pure half.
 *
 * Every `.agi` envelope's project.json carries a `sites` block, keyed by a 16-hex id, each entry the
 * shape Genie 1 wrote (`DevSiteConfig`: name, genName, repo, runMode, kind, enabled, and either a
 * `hostServe` mode, a `command`, or a `hostPort`). That block is the SOURCE OF TRUTH: it is git-tracked,
 * it travels with the project, and it is what Genie 1 hosted from. The envelope's shape is governed by
 * `Civicognita/shared-schemas` (where `sites` is an open object); this module reads and writes the
 * entries Genie 1 already wrote, and adds no new field.
 *
 * Reading maps each entry onto what Genie 2's site manager can serve, or onto the REASON it cannot —
 * an entry is never dropped. Writing edits ONE key of the manifest (`sites`) and carries every other
 * key through untouched, in the file's own indentation and line endings.
 */

/** What Genie 2 serves (mirrors `SiteServe` in main/site-manager.ts, kept here so core stays pure). */
export type EnvelopeServe =
    | { readonly mode: 'proxy' }
    | { readonly mode: 'static'; readonly root: string; readonly spa: boolean }
    | { readonly mode: 'php'; readonly root: string };

export type EnvelopeStack = 'laravel' | 'node' | 'django' | 'go';

export interface ServableSite {
    readonly key: string;
    readonly ok: true;
    readonly name: string;
    readonly enabled: boolean;
    /** The envelope-relative folder the site serves from (`.` = the envelope itself). */
    readonly repoDir: string;
    readonly serve: EnvelopeServe;
    /** proxy: the dev server to run, `{port}` substituted at start. */
    readonly devServer?: { readonly stack: EnvelopeStack; readonly command: string };
    /** proxy: env the dev server reads its port from (`{port}` substituted at start), when its command names none. */
    readonly portEnv?: Readonly<Record<string, string>>;
    /** proxy: a server already listening; Genie starts nothing. */
    readonly hostPort?: number;
}

export interface UnservableSite {
    readonly key: string;
    readonly ok: false;
    readonly name: string;
    readonly enabled: boolean;
    /** The `.gen` name the entry asks for, as written (or `<name>.gen`). */
    readonly host: string;
    readonly repoDir: string | null;
    readonly reason: string;
}

export type EnvelopeSite = ServableSite | UnservableSite;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Where `repo` points, against the manifest's `repos[]`: an entry whose slug, name, path or folder name
 * is `repo` gives its path; `''` is the envelope itself; otherwise Genie 1's own meaning, `repos/<repo>`.
 * `null` when `repo` is not one folder name (it would leave the envelope).
 */
export function resolveRepoDir(manifest: Record<string, unknown>, repo: string): string | null {
    if (repo === '' || repo === '.') return '.';
    if (repo.includes('/') || repo.includes('\\') || repo === '..') return null;
    const repos = Array.isArray(manifest.repos) ? manifest.repos.filter(isRecord) : [];
    for (const r of repos) {
        const path = typeof r.path === 'string' ? r.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') : null;
        if (path === null) continue;
        if (r.slug === repo || r.name === repo || path === repo || path.split('/').at(-1) === repo) return path === '' ? '.' : path;
    }
    return `repos/${repo}`;
}

/** A shell word for the dev-server command line: bare when safe, double-quoted otherwise. */
function word(token: string): string {
    return /^[A-Za-z0-9_@%+=:,./\\{}-]+$/.test(token) ? token : `"${token.replace(/"/g, '\\"')}"`;
}

function stackOf(argv: readonly string[], entry: Record<string, unknown>): EnvelopeStack {
    const fw = entry.framework;
    const stack = entry.stack;
    if (fw === 'laravel' || stack === 'php' || argv[0] === 'php') return 'laravel';
    if (fw === 'django' || stack === 'python' || argv[0] === 'python' || argv[0] === 'python3') return 'django';
    if (stack === 'go' || argv[0] === 'go') return 'go';
    return 'node';
}

/** Where `--port N` / `-p N` is, with a NUMBER after it (`--port auto` means something else); -1 when absent. */
/** `127.0.0.1:8000`, `localhost:8000`, `:8000` — a bind address with its port, as one token. */
const HOST_PORT = /^((?:\d{1,3}(?:\.\d{1,3}){3}|localhost)?):\d+$/;

const portFlagAt = (tokens: readonly string[]): number => tokens.findIndex((t, i) => (t === '--port' || t === '-p') && /^\d+$/.test(tokens[i + 1] ?? ''));

/**
 * The stored argv with `{port}` where its port is — Genie owns the port, so the one written down (often a
 * port another site holds) is replaced, the way Genie 1's `withPort` did. A server told `0.0.0.0` is told
 * loopback: every site Genie hosts binds loopback only. A command that names no port gets Genie 1's
 * fallback for its stack (Laravel `--port=`, Django `127.0.0.1:`, Vite `--port --strictPort`, else `PORT`).
 */
export function devServerFor(argv: readonly string[], entry: Record<string, unknown>): { command: string; portEnv?: Record<string, string> } {
    let tokens = argv.map((a) => a.replace(/^--host=0\.0\.0\.0$/, '--host=127.0.0.1'));
    let portEnv: Record<string, string> | undefined;
    if (tokens.some((t) => t.includes('{port}'))) {
        // already a Genie 2 command
    } else if (tokens.some((t) => t.startsWith('--port='))) {
        tokens = tokens.map((t) => (t.startsWith('--port=') ? '--port={port}' : t));
    } else if (portFlagAt(tokens) >= 0) {
        const i = portFlagAt(tokens);
        tokens = tokens.map((t, j) => (j === i + 1 ? '{port}' : t));
    } else if (tokens.some((t) => HOST_PORT.test(t))) {
        tokens = tokens.map((t) => {
            const m = HOST_PORT.exec(t);
            if (!m) return t;
            const bind = m[1] === undefined || m[1] === '' || m[1] === '0.0.0.0' ? '127.0.0.1' : m[1];
            return `${bind}:{port}`;
        });
    } else if (entry.framework === 'laravel' || entry.stack === 'php') {
        tokens = [...tokens, '--port={port}'];
    } else if (entry.framework === 'django') {
        tokens = [...tokens, '127.0.0.1:{port}'];
        portEnv = { PORT: '{port}' };
    } else if (entry.framework === 'vite') {
        tokens = [...tokens, '--', '--port', '{port}', '--strictPort'];
        portEnv = { PORT: '{port}' };
    } else {
        portEnv = { PORT: '{port}' };
    }
    return { command: tokens.map(word).join(' '), ...(portEnv ? { portEnv } : {}) };
}

function mapEntry(manifest: Record<string, unknown>, key: string, entry: Record<string, unknown>): EnvelopeSite {
    const enabled = entry.enabled === true;
    const genName = typeof entry.genName === 'string' ? entry.genName.toLowerCase() : null;
    const rawName = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : key;
    const repo = typeof entry.repo === 'string' ? entry.repo : '';
    const repoDir = resolveRepoDir(manifest, repo);
    const host = genName ?? `${rawName.toLowerCase()}.gen`;
    const refuse = (reason: string): UnservableSite => ({ key, ok: false, name: rawName, enabled, host, repoDir, reason });

    // The `.gen` name is the site's NAME in Genie 2: `<name>.gen`, `<name>` one or more labels — `tynn.gen`, and Genie 1's
    // own default `<site>.<workspace>.gen` (gen-name.ts). Every label is checked; the refusal names the one that is wrong.
    if (!host.endsWith('.gen')) return refuse(`its name ${host} is not a .gen name`);
    const label = host.slice(0, -'.gen'.length);
    if (!isGenHost(host)) return refuse(`its name ${host} is not a hostname Genie can serve: ${siteNameProblem(label) ?? 'not a .gen name'}`);
    if (repoDir === null) return refuse(`its repo ${JSON.stringify(repo)} is not a folder name inside the envelope`);
    if (entry.kind !== undefined && entry.kind !== 'http') return refuse(`it is a ${String(entry.kind)} site; Genie 2 hosts http sites`);
    const runMode = entry.runMode ?? 'host';
    if (runMode !== 'host') {
        return refuse(runMode === 'explicit'
            ? 'it runs inside the workspace container (runMode "explicit"); Genie 2 serves sites host-native only, so it is not started here'
            : `its runMode "${String(runMode)}" needs machinery Genie 2 does not have; Genie 2 serves host-native sites (runMode "host")`);
    }
    const base = { key, ok: true as const, name: label, enabled, repoDir };
    if (typeof entry.hostPort === 'number') {
        if (!Number.isInteger(entry.hostPort) || entry.hostPort < 1 || entry.hostPort > 65535) return refuse(`its hostPort ${entry.hostPort} is not a port`);
        return { ...base, serve: { mode: 'proxy' }, hostPort: entry.hostPort };
    }
    if (entry.hostServe !== undefined) {
        const hs = entry.hostServe;
        if (!isRecord(hs)) return refuse('its hostServe is not an object');
        if (hs.mode === 'static' || hs.mode === 'php') {
            if (typeof hs.root !== 'string' || hs.root.length === 0) return refuse(`its hostServe ${hs.mode} names no root folder`);
            if (hs.mode === 'php' && typeof hs.version === 'string') {
                return refuse(`it pins PHP ${hs.version}; Genie 2 serves php through the php-cgi on this machine and cannot honour a pinned version, so it is not started rather than served on another PHP`);
            }
            return { ...base, serve: hs.mode === 'static' ? { mode: 'static', root: hs.root, spa: hs.spa === true } : { mode: 'php', root: hs.root } };
        }
        return refuse(`its hostServe mode "${String(hs.mode)}" is not one Genie 2 serves yet (static, php, or the repo's own dev server)`);
    }
    const argv = Array.isArray(entry.command) && entry.command.length > 0 ? entry.command : Array.isArray(entry.serve) && entry.serve.length > 0 ? entry.serve : null;
    if (argv === null) return refuse('it names no way to serve it: no hostServe, no command, no hostPort');
    if (!argv.every((a): a is string => typeof a === 'string')) return refuse('its command is not a list of strings');
    const dev = devServerFor(argv, entry);
    return { ...base, serve: { mode: 'proxy' }, devServer: { stack: stackOf(argv, entry), command: dev.command }, ...(dev.portEnv ? { portEnv: dev.portEnv } : {}) };
}

/** Every site the manifest declares, in the file's order; an unreadable entry is an unservable one, never skipped. */
export function readEnvelopeSites(manifest: unknown): EnvelopeSite[] {
    if (!isRecord(manifest) || !isRecord(manifest.sites)) return [];
    return Object.entries(manifest.sites).map(([key, entry]) =>
        isRecord(entry) ? mapEntry(manifest, key, entry) : { key, ok: false as const, name: key, enabled: false, host: `${key}.gen`, repoDir: null, reason: 'its entry is not an object' });
}

/** The key Genie 1 gives a site: sha256(workspace \0 name), 16 hex — so either Genie reads what the other wrote. */
export function siteKeyFor(workspaceId: string, name: string): string {
    return createHash('sha256').update(`${workspaceId}\0${name.toLowerCase()}`).digest('hex').slice(0, 16);
}

export interface NewSiteEntry {
    readonly name: string;
    /** The site's folder relative to the envelope (`.` = the envelope). */
    readonly repoDir: string;
    readonly serve: EnvelopeServe;
    readonly devServer?: { readonly command: string };
    readonly hostPort?: number;
}

/** A command line back to argv (quotes honoured), for the `command` Genie 1's shape stores. */
function argvOf(command: string): string[] {
    const out: string[] = [];
    const re = /"((?:[^"\\]|\\"|\\(?!"))*)"|'([^']*)'|(\S+)/g;
    for (let m = re.exec(command); m !== null; m = re.exec(command)) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : (m[2] ?? m[3]!));
    return out;
}

/**
 * The project.json entry for a site created in Genie 2, in Genie 1's shape. `repo` is the folder name
 * Genie 1 resolves (`repos/<repo>`), or `''` for the envelope itself; a site in a deeper folder is
 * named by the repos[] entry whose path it is.
 */
export function siteEntryFor(manifest: Record<string, unknown>, site: NewSiteEntry): { ok: true; entry: Record<string, unknown> } | { ok: false; reason: string } {
    let repo: string | null = null;
    if (site.repoDir === '.') repo = '';
    else {
        const repos = Array.isArray(manifest.repos) ? manifest.repos.filter(isRecord) : [];
        const match = repos.find((r) => typeof r.path === 'string' && r.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') === site.repoDir);
        if (match) repo = typeof match.slug === 'string' ? match.slug : typeof match.name === 'string' ? match.name : null;
        if (repo === null && /^repos\/[^/]+$/.test(site.repoDir)) repo = site.repoDir.slice('repos/'.length);
        if (repo !== null && resolveRepoDir(manifest, repo) !== site.repoDir) repo = null;
    }
    if (repo === null) return { ok: false, reason: `${site.repoDir} is not a registered repo of this workspace, nor a folder under repos/; add it as a repo first` };
    // Genie 1's shape: `name` is ONE label (Genie 1 drops a row whose name is not one — sites-config.ts
    // `sanitizeDevSitePatch`), `genName` the full host. A Genie 2 site `web.acme` is { name: 'web', genName: 'web.acme.gen' },
    // exactly what Genie 1's own default wrote; one label `docs` is { name: 'docs', genName: 'docs.gen' } as before.
    const entry: Record<string, unknown> = { repo, runMode: 'host', kind: 'http', enabled: true, name: site.name.split('.')[0]!, genName: `${site.name}.gen` };
    if (site.serve.mode === 'static') entry.hostServe = { mode: 'static', root: site.serve.root, spa: site.serve.spa };
    else if (site.serve.mode === 'php') entry.hostServe = { mode: 'php', root: site.serve.root };
    else if (site.hostPort !== undefined) entry.hostPort = site.hostPort;
    else if (site.devServer) entry.command = argvOf(site.devServer.command);
    else return { ok: false, reason: 'a proxy site needs a dev server or a hostPort' };
    return { ok: true, entry };
}

/** The fields that say HOW a site is served — replaced whole by an edit, never mixed (a stale `hostPort` beside a new `hostServe` would be two answers). */
const SERVE_FIELDS = ['hostServe', 'hostPort', 'command', 'serve'] as const;

/**
 * An EDITED site's entry: the existing entry with its name, folder and way of serving replaced by `next` (a
 * {@link siteEntryFor} result), and everything else it carries — `enabled`, Genie 1's own fields (`framework`, `stack`,
 * `upstreamHost`…) — kept as it was, in its place. Genie 2 changes what the person edited and nothing they did not.
 */
export function editedSiteEntry(existing: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
    const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => !(SERVE_FIELDS as readonly string[]).includes(k)));
    const merged: Record<string, unknown> = { ...kept, ...next };
    // Whether it starts is the person's, from before the edit: an edit is not an enable.
    if ('enabled' in existing) merged.enabled = existing.enabled;
    return merged;
}

/** The manifest with `sites[key]` set (or deleted when `entry` is null); every other key and its order kept. */
export function withSiteEntry(manifest: Record<string, unknown>, key: string, entry: Record<string, unknown> | null): Record<string, unknown> {
    const sites = isRecord(manifest.sites) ? { ...manifest.sites } : {};
    if (entry === null) delete sites[key];
    else sites[key] = entry;
    if ('sites' in manifest) return Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, k === 'sites' ? sites : v]));
    return { ...manifest, sites };
}

/**
 * The manifest as text in the ORIGINAL file's style: its indentation (spaces or a tab, as many as it
 * used), its line endings, and whether it ended in a newline. A person's editor settings are not Genie's
 * to change, and a re-indented file is a diff over every line of a git-tracked file.
 */
export function formatLike(original: string, value: unknown): string {
    const indentMatch = /^[{[][^\S\r\n]*\r?\n([ \t]+)\S/.exec(original);
    const indent = indentMatch ? indentMatch[1]! : '  ';
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const trailing = /\r?\n$/.test(original) || original.length === 0;
    const body = JSON.stringify(value, null, indent);
    return `${eol === '\n' ? body : body.replace(/\n/g, eol)}${trailing ? eol : ''}`;
}
