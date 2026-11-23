import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { restrictPrivateFile } from '../src/main/private-credentials.js';

/**
 * P7.2 — THE DATA ROOT HAS A MANIFEST (`.ai/plans/genie-2-host-split-2026-10-31.md`, "P7 build spec: one data root", item 2;
 * Tynn #418).
 *
 * genie-host writes `<home>/data-root.json` at start: the format version, the host build that wrote it, and two lists.
 * STATE is kept (agents, threads, inbox, settings, flows…); MACHINE is re-derived on start and safe to delete (host.json,
 * ports, ledgers, caches, downloaded runtimes, logs). Every State entry also says whether it TRAVELS: a secret or a login
 * that lives in the root (the gen CA's key, a provider's own login files, database passwords, site logins, trust) is state
 * of THIS machine's root and is never put in a bundle for another one (P8 reads that).
 *
 * THE COMPLETENESS ROW is three rows, none of them a list a person keeps by hand:
 *  1. every path genie-host.ts itself joins onto its root or its runtime folder is in a list;
 *  2. every file name shaped like a data file that host-side code names anywhere is in a list, or is named below as not
 *     the root's, with the reason (and a name nothing uses any more fails too);
 *  3. a real genie-host, started on an empty root as its own process: every file and folder it made is in a list.
 * A new store in no list fails 1 or 2 where it is written, and 3 when it is written at start.
 */

interface Rule { readonly path: string; readonly kind: 'state' | 'machine'; readonly holds: string; readonly travels?: boolean; readonly names?: readonly string[]; readonly atStart?: boolean }
interface Manifest { readonly format: number; readonly build: string; readonly state: ReadonlyArray<{ readonly path: string; readonly travels: boolean }>; readonly machine: readonly string[] }
interface DataRootModule {
    DATA_ROOT_FILE: string;
    DATA_ROOT_FORMAT: number;
    DATA_ROOT_RULES: readonly Rule[];
    classifyDataPath(relative: string): Rule | null;
    dataRootManifest(build: string): Manifest;
    writeDataRootManifest(home: string, build: string): Promise<void>;
}
// Loaded by a path the type checker does not follow, so each row fails on its own while the module is not there.
async function dataRoot(): Promise<DataRootModule> { const path: string = '../src/main/data-root.js'; return import(path) as Promise<DataRootModule>; }

const made: string[] = [];
const children: ChildProcess[] = [];
afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    await new Promise((done) => setTimeout(done, 500));
    for (const d of made) await rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };

describe('the two lists', () => {
    it('every rule is state or machine, says what it holds, and no path is listed twice', async () => {
        const { DATA_ROOT_RULES } = await dataRoot();
        expect(DATA_ROOT_RULES.length).toBeGreaterThan(40);
        for (const r of DATA_ROOT_RULES) {
            expect(['state', 'machine'], r.path).toContain(r.kind);
            expect(r.holds.length, r.path).toBeGreaterThan(5);
            // Relative, forward slashes, no `..`, and a folder (it and all in it) ends with one slash.
            expect(r.path, r.path).toMatch(/^[\w.@-]+(?:\/[\w.@-]+)*\/?$/);
            expect(r.path.split('/'), r.path).not.toContain('..');
        }
        const paths = DATA_ROOT_RULES.map((r) => r.path.replace(/\/$/, ''));
        expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
    });

    it('EVERY STATE RULE SAYS WHETHER IT TRAVELS, in so many words; a machine rule never does', async () => {
        const { DATA_ROOT_RULES } = await dataRoot();
        const unsaid = DATA_ROOT_RULES.filter((r) => r.kind === 'state' && typeof r.travels !== 'boolean').map((r) => r.path);
        expect(unsaid).toEqual([]);
        expect(DATA_ROOT_RULES.filter((r) => r.kind === 'machine' && r.travels !== undefined).map((r) => r.path)).toEqual([]);
        // Control: both answers are in use, so the row above is not passing on a table where nothing travels (or all does).
        expect(DATA_ROOT_RULES.some((r) => r.travels === true)).toBe(true);
        expect(DATA_ROOT_RULES.some((r) => r.travels === false)).toBe(true);
    });

    it('what the spec names is where the spec says: state kept, machine re-derived', async () => {
        const { classifyDataPath } = await dataRoot();
        const kind = (p: string): string | undefined => classifyDataPath(p)?.kind;
        const state = ['runtime/agents.json', 'runtime/workspaces.json', 'runtime/sessions/0123abcd.jsonl', 'runtime/sessions/0123abcd/att-1.png', 'runtime/inbox/mail.json', 'runtime/inbox/attachments/ab12',
            'runtime/attention.json', 'runtime/attention-history.json', 'runtime/attention-archive.jsonl', 'runtime/knowledge.db', 'runtime/settings.json', 'runtime/chat-drafts.json', 'runtime/chat-drafts/d1',
            'runtime/flows.json', 'runtime/processes.json', 'runtime/app-inbox.json', 'workstation.json', 'runtime/gen-ca/ca.key', 'data-root.json',
            // Ruled 2026-11-23: what the person stopped is state; a rebuilt machine must not start it.
            'runtime/engine-run-state.json', 'runtime/site-run-state.json'];
        const machine = ['runtime/host.json', 'runtime/host.token', 'runtime/host.sock', 'mcp-endpoint.json', 'app-inbox-endpoint.json', 'runtime/children.json', 'runtime/ptys.json',
            'runtime/caddy-bin/abc/caddy', 'runtime/caddy/Caddyfile', 'genie2-toolchain/playwright/sets.json', 'runtime/prism-supervisor/x', 'runtime/host-proxy.json', 'cache/tmp/1-2/x',
            // The host's own copy of its runtime and bundle (P6): made from the install, never restored from another machine.
            'host/runtime-39.0.0/.complete', 'logs/genie-host.log', 'runtime/lifecycle.log', 'runtime/lifecycle.log.1', 'runtime/crash/2026.json'];
        expect(state.filter((p) => kind(p) !== 'state')).toEqual([]);
        expect(machine.filter((p) => kind(p) !== 'machine')).toEqual([]);
    });

    it('a secret or a login that lives in the root is state that does NOT travel; the work itself does', async () => {
        const { classifyDataPath } = await dataRoot();
        const travels = (p: string): boolean | undefined => classifyDataPath(p)?.travels;
        const stays = ['accounts/claude/acct-1/.credentials.json', 'runtime/gen-ca/ca.key', 'runtime/services.json', 'browser/ws-1/main/Cookies', 'secrets/ab.secret', 'credentials/tynn.json', 'github.json',
            'agent-credentials/agents.json', 'runtime/device-hosts.json', 'runtime/remote-devices.json', 'runtime/mail-inboxes.json', 'runtime/workspace-trust.json'];
        const goes = ['runtime/agents.json', 'runtime/sessions/0123abcd.jsonl', 'runtime/inbox/mail.json', 'runtime/flows.json', 'runtime/knowledge.db'];
        expect(stays.filter((p) => travels(p) !== false)).toEqual([]);
        expect(goes.filter((p) => travels(p) !== true)).toEqual([]);
    });

    it('the folder itself is its rule’s; the longest rule wins; a path in no list is in no list', async () => {
        const { classifyDataPath } = await dataRoot();
        expect(classifyDataPath('runtime/sessions')?.path).toBe('runtime/sessions/');
        expect(classifyDataPath('runtime/sessions/')?.path).toBe('runtime/sessions/');
        // browser/.process is the browser process's own Chromium folder (machine) inside browser/ (state).
        expect(classifyDataPath('browser/.process/Local State')?.kind).toBe('machine');
        expect(classifyDataPath('browser/ws-1/main/Cookies')?.kind).toBe('state');
        // A folder that only holds listed things is not itself a store, and a name nothing lists is not guessed at.
        expect(classifyDataPath('runtime')).toBeNull();
        expect(classifyDataPath('runtime/a-new-store.json')).toBeNull();
        expect(classifyDataPath('a-new-folder/x')).toBeNull();
        expect(classifyDataPath('runtime/agents.json.bak')).toBeNull();
        expect(classifyDataPath('../outside.json')).toBeNull();
        // Windows' separator reads the same.
        expect(classifyDataPath('runtime\\sessions\\0123abcd.jsonl')?.path).toBe('runtime/sessions/');
    });

    it('what a write leaves half-done is machine, whatever it was writing; a database’s own side files are the database’s', async () => {
        const { classifyDataPath } = await dataRoot();
        for (const left of ['runtime/agents.json.4242.17.tmp', 'runtime/ptys.json.4242.tmp', 'github.json.tmp', 'marketplace-publisher-keys.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp',
            'runtime/workspace-trust.json.unreadable', 'keychain-migration.json.corrupt-1700000000000']) {
            expect(classifyDataPath(left)?.kind, left).toBe('machine');
        }
        expect(classifyDataPath('runtime/knowledge.db-wal')?.path).toBe('runtime/knowledge.db');
        expect(classifyDataPath('runtime/knowledge.db-shm')?.kind).toBe('state');
        // Inside a folder a rule lists whole, everything is the folder's: a leftover there is not sorted out one by one.
        expect(classifyDataPath('credentials/tynn.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp')?.path).toBe('credentials/');
        // Control: the leftover rule is for a LISTED file's leftovers only.
        expect(classifyDataPath('runtime/a-new-store.json.4242.17.tmp')).toBeNull();
    });
});

describe('the manifest', () => {
    it('is the format, the build and the two lists: every rule in exactly one, each state entry with whether it travels', async () => {
        const { DATA_ROOT_RULES, DATA_ROOT_FORMAT, dataRootManifest } = await dataRoot();
        const m = dataRootManifest('2.0.0-beta.66+abc123');
        expect(Object.keys(m).sort()).toEqual(['build', 'format', 'machine', 'state']);
        expect(m.format).toBe(DATA_ROOT_FORMAT);
        expect(m.format).toBe(1);
        expect(m.build).toBe('2.0.0-beta.66+abc123');
        expect(m.state).toEqual(DATA_ROOT_RULES.filter((r) => r.kind === 'state').map((r) => ({ path: r.path, travels: r.travels })));
        expect(m.machine).toEqual(DATA_ROOT_RULES.filter((r) => r.kind === 'machine').map((r) => r.path));
        expect(m.state.length + m.machine.length).toBe(DATA_ROOT_RULES.length);
        expect(m.state.length).toBeGreaterThan(15);
        expect(m.machine.length).toBeGreaterThan(15);
    });

    it('is written whole to <home>/data-root.json, and written again it replaces the last one', async () => {
        const { DATA_ROOT_FILE, dataRootManifest, writeDataRootManifest } = await dataRoot();
        expect(DATA_ROOT_FILE).toBe('data-root.json');
        const home = temp('genie-p7-manifest-');
        await writeDataRootManifest(home, 'build-one');
        expect(JSON.parse(readFileSync(join(home, 'data-root.json'), 'utf8'))).toEqual(dataRootManifest('build-one'));
        await writeDataRootManifest(home, 'build-two');
        expect(JSON.parse(readFileSync(join(home, 'data-root.json'), 'utf8'))).toEqual(dataRootManifest('build-two'));
        // Nothing half-written is left beside it.
        expect(readdirSync(home)).toEqual(['data-root.json']);
    });

    it('NOTHING SECRET AND NOTHING OF THIS MACHINE: no value read from the root, no absolute path, only the rules’ own words', async () => {
        const { DATA_ROOT_RULES, writeDataRootManifest } = await dataRoot();
        const home = temp('genie-p7-nosecret-');
        // A root that holds secrets where the host keeps them: the manifest must carry none of it.
        const token = `tok-${randomBytes(12).toString('hex')}`;
        mkdirSync(join(home, 'runtime'), { recursive: true });
        mkdirSync(join(home, 'secrets'), { recursive: true });
        writeFileSync(join(home, 'runtime', 'host.token'), token);
        writeFileSync(join(home, 'mcp-endpoint.json'), JSON.stringify({ port: 4242, token }));
        writeFileSync(join(home, 'runtime', 'services.json'), JSON.stringify({ password: token }));
        writeFileSync(join(home, 'secrets', 'ab.secret'), token);
        await writeDataRootManifest(home, 'build-one');
        const text = readFileSync(join(home, 'data-root.json'), 'utf8');
        // Control: the secret is really in the root this manifest was written for.
        expect(readFileSync(join(home, 'runtime', 'host.token'), 'utf8')).toBe(token);
        expect(text).not.toContain(token);
        expect(text).not.toContain(home);
        expect(text).not.toContain(home.replace(/\\/g, '/'));
        expect(text).not.toContain(home.replace(/\\/g, '\\\\'));
        expect(text).not.toContain(tmpdir());
        // Every string in it is the build or a rule's path: nothing else can be in there.
        const allowed = new Set<string>(['build-one', ...DATA_ROOT_RULES.map((r) => r.path)]);
        const strings: string[] = [];
        JSON.parse(text, (_key, value: unknown) => { if (typeof value === 'string') strings.push(value); return value; });
        expect(strings.filter((s) => !allowed.has(s))).toEqual([]);
        expect(strings.length).toBe(DATA_ROOT_RULES.length + 1);
    });
});

// --- COMPLETENESS, FROM THE SOURCE ----------------------------------------------------------------------------------------

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
const typeOnly = (statement: string): boolean => /^\s*(?:import|export)\s+type\s/.test(statement);

/** The static import graph from an entry (test/p7-one-data-root.test.ts's walk). */
function graph(entry: string, seen: Set<string>): void {
    const walk = (file: string): void => {
        if (seen.has(file) || !existsSync(file)) return;
        seen.add(file);
        for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
            if (typeOnly(m[0])) continue;
            const spec = m[1] ?? m[2];
            if (spec && spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
        }
    };
    walk(resolve(entry));
}
/** Host-side code: genie-host's graph, and the two processes it starts (the browser process, the updater helper). */
const hostSide = (): string[] => {
    const all = new Set<string>();
    for (const e of ['src/main/genie-host.ts', 'src/main/browser-process.ts', 'src/main/updater-process.ts']) graph(e, all);
    return [...all].filter((f) => f.endsWith('.ts'));
};
const rel = (file: string): string => file.slice(resolve('.').length + 1).replace(/\\/g, '/');

/** Code lines only: comments say nothing the rows below count. */
function codeLines(file: string): Array<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    let inBlock = false;
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, i) => {
        let text = raw.trim();
        if (inBlock) { if (text.includes('*/')) { inBlock = false; text = text.slice(text.indexOf('*/') + 2).trim(); } else return; }
        if (text.startsWith('/*')) { if (!text.includes('*/')) { inBlock = true; return; } text = text.slice(text.indexOf('*/') + 2).trim(); }
        if (text.startsWith('//') || text.startsWith('*') || text === '') return;
        out.push({ line: i + 1, text: text.replace(/\s\/\/\s.*$/, '') });
    });
    return out;
}

describe('completeness 1: every path genie-host.ts joins onto its root or its runtime folder is in a list', () => {
    const HOST = 'src/main/genie-host.ts';
    /** `join(home, 'a', 'b'` and `join(runtime, 'a'`: the literal segments that follow the root, as one relative path. */
    const JOIN = /\bjoin\((home|runtime)((?:,\s*'[^']*')*)\s*(,\s*[^')\s][^,)]*)?/g;
    const joins = (): Array<{ line: number; relative: string; open: boolean; text: string }> => codeLines(resolve(HOST)).flatMap((l) => [...l.text.matchAll(JOIN)].map((m) => {
        const segments = [...(m[2] ?? '').matchAll(/'([^']*)'/g)].map((s) => s[1]!);
        return { line: l.line, relative: [...(m[1] === 'runtime' ? ['runtime'] : []), ...segments].join('/'), open: segments.length === 0, text: l.text.slice(0, 160) };
    }));

    it('finds them (control: host.json, the Tynn credential and the logs are among them)', () => {
        const found = joins().map((j) => j.relative);
        expect(found.length).toBeGreaterThan(25);
        for (const known of ['runtime/host.json', 'runtime/host.token', 'credentials/tynn.json', 'workstation.json', 'runtime/children.json']) expect(found).toContain(known);
        expect(found.some((f) => f.startsWith('logs'))).toBe(true);
    });

    it('each is in a list', async () => {
        const { classifyDataPath } = await dataRoot();
        const unlisted = joins().filter((j) => !j.open && classifyDataPath(j.relative) === null).map((j) => `${HOST}:${j.line}: ${j.relative}`);
        expect(unlisted).toEqual([]);
    });

    it('none joins a name that is not written there onto the bare root: the list could not be checked', () => {
        expect(joins().filter((j) => j.open).map((j) => `${HOST}:${j.line}: ${j.text}`)).toEqual([]);
    });

    it('the folders named through paths.ts are in a list too: the OSA’s home, the threads, the scratch', async () => {
        const { classifyDataPath } = await dataRoot();
        const paths = await import('../src/main/paths.js');
        const root = resolve('/', 'p7-root');
        const relative = (p: string): string => p.slice(root.length + 1).replace(/\\/g, '/');
        expect(classifyDataPath(relative(paths.osaHomeDir(root)))?.kind).toBe('state');
        expect(classifyDataPath(relative(paths.sessionsDir(root)))?.kind).toBe('state');
        expect(classifyDataPath(relative(paths.scratchDir(root)))?.kind).toBe('machine');
        // The runtime folder holds both kinds: it is not a store, its files are.
        expect(classifyDataPath(relative(paths.runtimeDir(root)))).toBeNull();
    });
});

/**
 * COMPLETENESS 2. A store is written under a name. Every quoted name in host-side code that ends like a data file is
 * either a file a rule lists (its path, or one of the `names` a folder's rule says are in it), or one of the names below:
 * files that are NOT in the data root, each group with the reason. A new `join(dir, 'new-store.json')` anywhere host-side
 * is in neither, and fails here until it is put in a list.
 */
const DATA_NAME = /['"`]((?:[\w.@-]+\/)*[\w.@-]*[\w-]\.(?:json|jsonl|db|log|token|sock|pid|toml|pem|crt|key|ini|lock|secret))['"`]/g;
const NOT_THE_ROOTS: ReadonlyArray<{ readonly why: string; readonly names: readonly string[] }> = [
    { why: 'a workspace’s own files, in the workspace’s folder (the spec’s exception: handoff notes and harness configs are the workspace’s)',
        names: ['project.json', '.mcp.json', 'mcp.json', 'settings.local.json', 'config.toml', 'tabs.json', 'genie-trash.json', 'index.json', 'history.jsonl', 'index.lock'] },
    { why: 'a project’s package files, read to learn what it runs', names: ['package.json', 'package-lock.json', 'yarn.lock'] },
    { why: 'inside a plugin or GApp package, or the plugin Genie generates for an agent', names: ['genie-package.json', 'plugin.json'] },
    { why: 'files of a runtime Genie installed (under genie2-toolchain/, machine) or of the OS', names: ['php.ini', 'Thumbs.db'] },
    { why: 'Genie 1’s database and its CA files, in Genie 1’s own folder: read once for the import, never written', names: ['genie.db', 'gen-ca.crt', 'gen-ca.key'] },
    { why: 'a protocol method’s name (host.lock, remote.lock), not a file', names: ['host.lock', 'remote.lock'] },
];

describe('completeness 2: every data file host-side code names is in a list, or is named here as not the root’s', () => {
    const literals = (): Array<{ file: string; line: number; name: string; literal: string }> => hostSide().flatMap((f) => codeLines(f).flatMap((l) => [...l.text.matchAll(DATA_NAME)]
        // An absolute path is the OS's or a container's (`/etc/ssl/cert.pem`, `/data/mailpit.db`): never under the root.
        .filter((m) => !m[1]!.startsWith('/'))
        .map((m) => ({ file: rel(f), line: l.line, literal: m[1]!, name: m[1]!.split('/').pop()! }))));

    it('reads the host’s whole graph (control: the scanner finds the registry, the mail store and a workspace’s project.json)', () => {
        const names = new Set(literals().map((l) => l.name));
        expect(names.size).toBeGreaterThan(80);
        for (const known of ['agents.json', 'workspaces.json', 'mail.json', 'flows.json', 'host.token', 'knowledge.db', 'project.json']) expect(names).toContain(known);
    });

    it('each name is a listed file’s, or a named exception’s', async () => {
        const { DATA_ROOT_RULES } = await dataRoot();
        const listed = new Set<string>();
        for (const r of DATA_ROOT_RULES) { listed.add(r.path.replace(/\/$/, '').split('/').pop()!); for (const n of r.names ?? []) listed.add(n); }
        const excepted = new Set(NOT_THE_ROOTS.flatMap((g) => g.names));
        const unlisted = literals().filter((l) => !listed.has(l.name) && !excepted.has(l.name)).map((l) => `${l.file}:${l.line}: ${l.literal}`);
        expect(unlisted).toEqual([]);
    });

    it('a name is never both: listed AND excepted would hide a store behind a workspace file of the same name', async () => {
        const { DATA_ROOT_RULES } = await dataRoot();
        const excepted = new Set(NOT_THE_ROOTS.flatMap((g) => g.names));
        const both = DATA_ROOT_RULES.flatMap((r) => [r.path.replace(/\/$/, '').split('/').pop()!, ...(r.names ?? [])]).filter((n) => excepted.has(n));
        // settings.json is the one name with two homes: Genie's own (runtime/settings.json, listed) and a provider's or a
        // workspace's (.claude/settings.json). It is listed, so it is not excepted, and that is the whole of it.
        expect(both).toEqual([]);
    });

    it('every exception, and every name a folder’s rule says is in it, is still named in the code (a stale one is a hole)', async () => {
        const { DATA_ROOT_RULES } = await dataRoot();
        const used = new Set(literals().map((l) => l.name));
        expect(NOT_THE_ROOTS.flatMap((g) => g.names).filter((n) => !used.has(n))).toEqual([]);
        expect(DATA_ROOT_RULES.flatMap((r) => (r.names ?? []).map((n) => `${r.path} ${n}`)).filter((n) => !used.has(n.split(' ')[1]!))).toEqual([]);
    });
});

// --- COMPLETENESS, FROM A REAL HOST -------------------------------------------------------------------------------------

const TSX = import.meta.resolve('tsx');
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Every file and folder under the root, relative, with `/`. A folder some rule lists whole is one entry: not walked into. */
function entries(home: string, wholeFolder: (relative: string) => boolean): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
        let names: Array<{ name: string; isDirectory(): boolean }>;
        try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of names) {
            const relative = `${prefix}${d.name}`;
            if (d.isDirectory() && !wholeFolder(relative)) { walk(join(dir, d.name), `${relative}/`); continue; }
            out.push(d.isDirectory() ? `${relative}/` : relative);
        }
    };
    walk(home, '');
    return out.sort();
}

describe('completeness 3: a real genie-host on an empty root', () => {
    it('writes data-root.json before host.json names it to a window, and everything it made in its root is in a list', async () => {
        const home = temp('genie-p7-real-');
        const keys = temp('genie-p7-key-');
        const keyFile = join(keys, 'secret.key');
        writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
        // Owner-only, as the host demands of its key file: on Windows that is an ACL (the first Windows run was refused on it), on POSIX the mode above.
        await restrictPrivateFile(keyFile);
        let log = '';
        // The secrets in sealed files under the root (GENIE_SECRET_BACKEND=file): this test never touches a real keychain.
        const child = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
            env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'p7-manifest-test', GENIE_HOST_IDLE_MS: '600000', GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: keyFile },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(child);
        child.stdout?.on('data', (d) => { log += String(d); });
        child.stderr?.on('data', (d) => { log += String(d); });

        const hostJson = join(home, 'runtime', 'host.json');
        const manifestFile = join(home, 'data-root.json');
        let manifestBeforeRecord: boolean | null = null;
        const deadline = Date.now() + 150_000;
        while (!existsSync(hostJson)) {
            if (existsSync(manifestFile)) manifestBeforeRecord = true;
            if (child.exitCode !== null) throw new Error(`genie-host exited ${child.exitCode} before serving:\n${log}`);
            if (Date.now() > deadline) throw new Error(`genie-host did not serve in time:\n${log}`);
            await sleep(25);
        }
        // CONTROL: this is that host, serving: its own pid is in the record.
        expect((JSON.parse(readFileSync(hostJson, 'utf8')) as { pid: number }).pid).toBe(child.pid);
        // What starts by itself after the record (sweeps, the first saves) gets its time too.
        await sleep(5_000);

        const made = entries(home, () => false);
        console.log(`[p7] a host on an empty root made:\n${made.join('\n')}`);
        expect(existsSync(manifestFile), `no data-root.json; the host made:\n${made.join('\n')}`).toBe(true);
        expect(manifestBeforeRecord).toBe(true);

        const { classifyDataPath, dataRootManifest, DATA_ROOT_RULES } = await dataRoot();
        expect(JSON.parse(readFileSync(manifestFile, 'utf8'))).toEqual(dataRootManifest('p7-manifest-test'));

        const top = entries(home, (relative) => classifyDataPath(relative)?.path === `${relative}/`);
        // CONTROL: the walk sees what a host always makes.
        for (const always of ['runtime/host.json', 'runtime/host.token', 'data-root.json']) expect(top).toContain(always);
        expect(top.length).toBeGreaterThan(8);
        expect(top.filter((p) => classifyDataPath(p) === null)).toEqual([]);

        // What a rule says a host makes at start is there: a rule that names nothing real would prove nothing.
        const atStart = DATA_ROOT_RULES.filter((r) => r.atStart === true);
        expect(atStart.length).toBeGreaterThan(5);
        expect(atStart.filter((r) => !existsSync(join(home, r.path))).map((r) => r.path)).toEqual([]);
    }, 240_000);
});
