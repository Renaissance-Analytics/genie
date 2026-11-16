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

export type LockKind = 'package-lock' | 'pnpm' | 'yarn';

/** The `@playwright/test` version a project's lockfile pins, or `null` when it does not use Playwright (or the file cannot be read). */
export function parseLockedPlaywright(lockText: string, kind: LockKind): string | null {
    if (kind === 'package-lock') {
        try {
            const lock = JSON.parse(lockText) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
            return lock.packages?.['node_modules/@playwright/test']?.version ?? lock.dependencies?.['@playwright/test']?.version ?? null;
        } catch {
            return null;
        }
    }
    if (kind === 'pnpm') {
        const m = /'?@playwright\/test'?:\s*\r?\n\s+specifier:[^\r\n]*\r?\n\s+version:\s*'?([0-9][^\s('\r\n]*)/.exec(lockText);
        return m ? m[1]! : null;
    }
    const y = /"?@playwright\/test@[^\r\n]*:\s*\r?\n\s+version:?\s*"?([0-9][^"\s\r\n]*)/.exec(lockText);
    return y ? y[1]! : null;
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
