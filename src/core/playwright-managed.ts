import { join } from 'node:path';

/**
 * ONE PLAYWRIGHT, MANAGED BY GENIE (Tynn #604) — the pure half.
 *
 * Browser tests trip agents up: each worktree installs its own Playwright and downloads its own browsers. Genie keeps ONE
 * set of browsers in a folder of its own and hands that folder to everything it starts (`PLAYWRIGHT_BROWSERS_PATH`), and
 * runs ONE local browser server that agents may connect to (`PW_TEST_CONNECT_WS_ENDPOINT`). Nothing here runs a process or
 * reads a file; main/ does that and asks this file what the answer is.
 *
 * Measured on Azure (Linux and Windows) before this was written: the numbers are in the PR.
 */

export const PLAYWRIGHT_BROWSERS_ENV = 'PLAYWRIGHT_BROWSERS_PATH';
export const PLAYWRIGHT_ENDPOINT_ENV = 'PW_TEST_CONNECT_WS_ENDPOINT';

/** The one address the server may bind. Never a wildcard, never a name that resolves elsewhere. */
export const SERVER_HOST = '127.0.0.1';
/** A server with a short path is a server anyone on this machine can guess. `mintToken` gives 43. */
export const MIN_TOKEN_LENGTH = 24;

export interface PlaywrightDirs {
    readonly root: string;
    /** The one folder every Playwright version's browsers are installed into: Playwright names each revision's folder itself, so revisions two versions share are downloaded once. */
    readonly browsers: string;
    /** Which versions' browser sets are installed, and which browsers each holds. */
    readonly manifest: string;
    /** Where a version's Playwright CLI is installed (`npm install playwright@<version>` here). */
    cli(version: string): string;
}

export function playwrightDirs(toolchainDir: string): PlaywrightDirs {
    const root = join(toolchainDir, 'playwright');
    return { root, browsers: join(root, 'browsers'), manifest: join(root, 'sets.json'), cli: (version) => join(root, 'cli', version) };
}

/** The variable every terminal, process, site and agent Genie starts is given. */
export function playwrightEnv(toolchainDir: string): Record<string, string> {
    return { [PLAYWRIGHT_BROWSERS_ENV]: playwrightDirs(toolchainDir).browsers };
}

/**
 * Whether Genie's managed browsers folder holds a set Playwright can use (Tynn #604, the beta.64 regression): the manifest
 * records at least one version, and the folder holds a revision folder (`chromium-1194`, `chromium_headless_shell-1194`) for a
 * browser it records. Until then nothing is pointed at the folder, and Playwright's own default works as before.
 */
export function managedBrowsersReady(sets: Readonly<Record<string, readonly string[]>>, entries: readonly string[]): boolean {
    const browsers = new Set(Object.values(sets).flat());
    if (browsers.size === 0) return false;
    return entries.some((entry) => [...browsers].some((b) => entry.startsWith(`${b}-`) || entry.startsWith(`${b}_`)));
}

export type LockKind = 'package-lock' | 'pnpm' | 'yarn';

/**
 * WHAT A PLAYWRIGHT VERSION IS: `x.y.z`, digits only, and nothing else (Tynn #846 review). Every path that installs goes
 * through this: the lockfile parser, the installer's `ensure`, `installPlaywrightBrowsers`. A version comes from a
 * workspace's lockfile, i.e. from whatever repository was cloned, and on Windows npm runs through cmd.exe: a string like
 * `1.2.3 && calc` must never get as far as a command line.
 */
export function isPlaywrightVersion(value: unknown): value is string {
    return typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
}

const versionOrNull = (value: unknown): string | null => (isPlaywrightVersion(value) ? value : null);

/**
 * The `@playwright/test` version a project's lockfile pins, or `null` when it does not use Playwright, the file cannot be
 * read, or what it says is not an `x.y.z` (the WHOLE value is read and checked, never a prefix of it).
 */
export function parseLockedPlaywright(lockText: string, kind: LockKind): string | null {
    if (kind === 'package-lock') {
        try {
            const lock = JSON.parse(lockText) as { packages?: Record<string, { version?: unknown }>; dependencies?: Record<string, { version?: unknown }> };
            return versionOrNull(lock.packages?.['node_modules/@playwright/test']?.version ?? lock.dependencies?.['@playwright/test']?.version);
        } catch {
            return null;
        }
    }
    if (kind === 'pnpm') {
        const m = /'?@playwright\/test'?:[ \t]*\r?\n[ \t]+specifier:[^\r\n]*\r?\n[ \t]+version:[ \t]*'?([^'\r\n]*)/.exec(lockText);
        // pnpm may add a peer suffix, `1.62.1(…)`: only a suffix right after a whole x.y.z is dropped, then the rest is checked.
        return m ? versionOrNull(m[1]!.trim().replace(/^(\d+\.\d+\.\d+)\([^)]*\)$/, '$1')) : null;
    }
    const y = /"?@playwright\/test@[^\r\n]*:[ \t]*\r?\n[ \t]+version:?[ \t]*"?([^"\r\n]*)/.exec(lockText);
    return y ? versionOrNull(y[1]!.trim()) : null;
}

export type BrowserSetResolution =
    | { readonly kind: 'ready'; readonly version: string }
    | { readonly kind: 'missing'; readonly version: string; readonly note: string };

/** Whether Genie has a browser set for the Playwright a project uses; when not, the note names the version it needs and the ones it has. */
export function resolveBrowserSet(clientVersion: string, installed: readonly string[]): BrowserSetResolution {
    if (installed.includes(clientVersion)) return { kind: 'ready', version: clientVersion };
    const have = installed.length > 0 ? `Genie has browsers for Playwright ${installed.join(', ')}` : 'Genie has no Playwright browsers yet';
    return { kind: 'missing', version: clientVersion, note: `This project uses Playwright ${clientVersion}. ${have}. Install ${clientVersion}'s browsers from the Toolchain page; it downloads only what is not already there.` };
}

/** Which of the wanted browsers a version still needs: what its set already holds is never downloaded again. */
export function planBrowserInstall(version: string, browsers: readonly string[], installed: Readonly<Record<string, readonly string[]>>): { readonly download: readonly string[]; readonly have: readonly string[] } {
    const held = installed[version] ?? [];
    return { download: browsers.filter((b) => !held.includes(b)), have: browsers.filter((b) => held.includes(b)) };
}

const majorMinor = (v: string): string => v.split('.').slice(0, 2).join('.');

/** A client may use the server when both are the same major.minor: the protocol is the release's, patches share it. */
export function serverVersionMatch(client: string, server: string): { readonly ok: boolean; readonly note?: string } {
    if (majorMinor(client) === majorMinor(server)) return { ok: true };
    return { ok: false, note: `This project uses Playwright ${client}, but Genie's Playwright server runs ${server}; a client and its server must be the same version, so the server is not used here. Tests use the managed browsers directly.` };
}

export interface ServerEndpoint {
    readonly port: number;
    readonly token: string;
    readonly version: string;
}

export function endpointUrl(endpoint: Pick<ServerEndpoint, 'port' | 'token'>): string {
    return `ws://${SERVER_HOST}:${endpoint.port}/${endpoint.token}`;
}

/**
 * What a terminal, process or agent is given for Playwright: always the browsers path; the server's endpoint only when the
 * workspace opted in, the project uses Playwright and its version matches the server's. A mismatch carries a note naming both.
 */
export function playwrightChildEnv(input: { toolchainDir: string; optIn: boolean; clientVersion: string | null; server: ServerEndpoint | null }): { readonly env: Record<string, string>; readonly note?: string } {
    const env = playwrightEnv(input.toolchainDir);
    if (!input.optIn || input.clientVersion === null || input.server === null) return { env };
    const match = serverVersionMatch(input.clientVersion, input.server.version);
    if (!match.ok) return { env, ...(match.note ? { note: match.note } : {}) };
    return { env: { ...env, [PLAYWRIGHT_ENDPOINT_ENV]: endpointUrl(input.server) } };
}

const quote = (p: string): string => `"${p.replace(/"/g, '')}"`;

/** The server's command line. Loopback only and a long token in the path, or it refuses: an open server starts a browser for whoever connects. */
export function serverCommand(input: { cliDir: string; host: string; port: number; token: string }): { readonly command: string; readonly path: string } {
    if (input.host !== SERVER_HOST) throw new Error(`the Playwright server binds ${SERVER_HOST} only; ${input.host || 'an empty host'} is not allowed`);
    if (input.token.length < MIN_TOKEN_LENGTH) throw new Error(`the Playwright server needs an auth token of at least ${MIN_TOKEN_LENGTH} characters in its path`);
    const path = `/${input.token}`;
    const cli = join(input.cliDir, 'node_modules', 'playwright', 'cli.js');
    return { command: `node ${quote(cli)} run-server --host ${SERVER_HOST} --port ${input.port} --path ${path}`, path };
}

/** Stop a server nobody has used for the idle window. A gauge that cannot be read never reads as idle. */
export function decideIdle(input: { lastActiveAt: number; now: number; idleMs: number; connections: number | null }): 'stop' | 'keep' {
    if (input.connections === null || input.connections > 0) return 'keep';
    return input.now - input.lastActiveAt >= input.idleMs ? 'stop' : 'keep';
}

/**
 * Connections TO a port, from `ss -tn`, `netstat -an` (Linux) or `netstat -ano` (Windows): the lines that are established and whose
 * LOCAL end is that port (the client's own end of the same connection is not counted). `-1` when the output is not a socket listing.
 */
export function countEstablished(text: string, port: number): number {
    const lines = text.split(/\r?\n/);
    if (!lines.some((l) => /ESTAB|LISTEN|TIME_WAIT|Proto|State/i.test(l))) return -1;
    let count = 0;
    for (const line of lines) {
        if (!/ESTAB/i.test(line)) continue;
        const local = line.split(/\s+/).find((t) => /:\d+$/.test(t));
        if (local && Number(local.slice(local.lastIndexOf(':') + 1)) === port) count++;
    }
    return count;
}

/** Whether a worktree may share the main checkout's node_modules: only when both lockfiles exist and are byte-identical, and it has none of its own. */
export function worktreeLinkDecision(input: { mainLock: string | null; worktreeLock: string | null; worktreeHasNodeModules: boolean; mainHasNodeModules: boolean }): { readonly link: boolean; readonly reason?: string } {
    if (input.worktreeHasNodeModules) return { link: false, reason: 'the worktree already has a node_modules; it is left alone' };
    if (!input.mainHasNodeModules) return { link: false, reason: 'the main checkout has no node_modules installed to link to' };
    if (input.mainLock === null || input.worktreeLock === null) return { link: false, reason: 'a lockfile is missing, so nothing proves the worktree and the main checkout want the same packages' };
    if (input.mainLock !== input.worktreeLock) return { link: false, reason: 'the lockfiles differ: the worktree wants other packages than the main checkout has installed' };
    return { link: true };
}

// ---------------------------------------------------------------- Genie installs what agents need (Tynn #846)
// The owner, 2026-11-17: "agents need to use what is installed. genie should have been able to install it. I had to click
// the install button." Genie installs its browsers itself: the STABLE version at launch when it has none, each version a
// project's lockfile pins, and a version an agent asks for. Only what is unusually large waits for the person.

/**
 * THE STABLE CHANNEL: the Playwright version Genie installs when nothing else is asked for. Pinned here and raised on
 * purpose in a release, never read from the registry's newest, so the default does not move under projects.
 */
export const PLAYWRIGHT_STABLE = '1.65.1';
/** The Playwright version a workspace's agents should use: the project's own when Genie has it, else the stable one. */
export const PLAYWRIGHT_VERSION_ENV = 'GENIE_PLAYWRIGHT_VERSION';
/** Every version Genie has browsers for, comma-separated. */
export const PLAYWRIGHT_VERSIONS_ENV = 'GENIE_PLAYWRIGHT_VERSIONS';
/** `0` (or off/false/no) stops Genie installing browsers by itself: an offline machine, a test machine. Anything else, or unset, is on. */
export const PLAYWRIGHT_AUTO_INSTALL_ENV = 'GENIE_PLAYWRIGHT_AUTO_INSTALL';
/** The browsers Genie installs without asking anyone. */
export const MANAGED_BROWSERS: readonly string[] = ['chromium'];
/** The browsers Genie also installs, when someone asks for them. */
export const OPTIONAL_MANAGED_BROWSERS: readonly string[] = ['firefox', 'webkit'];
/** Past this many sets, one more is unusually large (each is a few hundred MB) and the person is asked first. */
export const MAX_AUTO_SETS = 6;
/** A failed install's Deck item: `genie:playwright-install:<version>`. */
export const PLAYWRIGHT_NOTICE_DECK_PREFIX = 'genie:playwright-install:';

/** `sets.json`: the browsers each version has, and the revision folders Playwright put them in (`--dry-run` says which). */
export interface BrowserManifest {
    readonly sets: Readonly<Record<string, readonly string[]>>;
    readonly folders?: Readonly<Record<string, readonly string[]>> | undefined;
}

export function autoInstallEnabled(value: string | undefined): boolean {
    return !/^(0|off|false|no)$/i.test((value ?? '').trim());
}

/** The revision folders `playwright install --dry-run` names (`Install location: …/chromium-1194`), by their own names. */
export function parseInstallLocations(text: string): string[] {
    return [...text.matchAll(/Install location:\s*(.+?)\s*$/gm)].map((m) => m[1]!.split(/[\\/]/).filter(Boolean).pop() ?? '').filter(Boolean);
}

/** The recorded versions whose browsers are really in the folder: every recorded revision folder there (or, for a set recorded before folders were, a folder of its browser). */
export function readyVersions(manifest: BrowserManifest, entries: readonly string[]): string[] {
    const present = new Set(entries.map((e) => e.split(/[\\/]/)[0]!));
    return Object.keys(manifest.sets).filter((version) => {
        const folders = manifest.folders?.[version] ?? [];
        if (folders.length > 0) return folders.every((f) => present.has(f));
        return (manifest.sets[version] ?? []).some((b) => [...present].some((e) => e.startsWith(`${b}-`) || e.startsWith(`${b}_`)));
    });
}

/** What Genie installs at launch: the stable version when it has no set at all, and nothing when it is switched off. */
export function launchInstall(input: { readonly enabled: boolean; readonly ready: readonly string[] }): string | null {
    return input.enabled && input.ready.length === 0 ? PLAYWRIGHT_STABLE : null;
}

export type InstallAsk =
    | { readonly kind: 'ready' }
    | { readonly kind: 'install' }
    | { readonly kind: 'ask'; readonly reason: string }
    | { readonly kind: 'refused'; readonly reason: string };

/** A project's or an agent's ask for a version's browsers: there already, installed now, asked of the person first (unusually large), or refused. */
export function decideInstallAsk(input: { readonly version: string; readonly browsers: readonly string[]; readonly ready: readonly string[]; readonly held: readonly string[] }): InstallAsk {
    if (!isPlaywrightVersion(input.version)) return { kind: 'refused', reason: `${input.version} is not a Playwright version (x.y.z, as your @playwright/test is)` };
    const known = [...MANAGED_BROWSERS, ...OPTIONAL_MANAGED_BROWSERS];
    const unknown = input.browsers.filter((b) => !known.includes(b));
    if (unknown.length > 0) return { kind: 'refused', reason: `Genie installs Playwright's ${known.join(', ')}; not ${unknown.join(', ')}` };
    const wanted = input.browsers.length > 0 ? input.browsers : MANAGED_BROWSERS;
    const isReady = input.ready.includes(input.version);
    const missing = wanted.filter((b) => !(isReady && input.held.includes(b)));
    if (missing.length === 0) return { kind: 'ready' };
    const extra = missing.filter((b) => !MANAGED_BROWSERS.includes(b));
    if (extra.length > 0) return { kind: 'ask', reason: `Playwright ${input.version}'s ${extra.join(' and ')} is another browser of a few hundred MB, beyond the Chromium Genie keeps by itself` };
    if (!isReady && input.ready.length >= MAX_AUTO_SETS) return { kind: 'ask', reason: `Genie already keeps ${input.ready.length} Playwright browser sets (${input.ready.join(', ')}); one more is a few hundred MB` };
    return { kind: 'install' };
}
