import { dirname, isAbsolute, join, resolve } from 'node:path';
import { countEstablished, playwrightChildEnv, resolveBrowserSet, serverVersionMatch, type ServerEndpoint } from '../core/playwright-managed.js';
import { installedVersions, linkWorktreeModules, projectPlaywrightVersion, type WorktreeLinkPorts } from './playwright-browsers.js';
import { PlaywrightServer, type PlaywrightServerPorts } from './playwright-server.js';
import type { PhpVersionsFs } from './php-versions.js';

/**
 * WHAT GENIE HANDS A WORKSPACE FOR PLAYWRIGHT (Tynn #604): per workspace, at the moment an agent session or a terminal for it
 * is started. The managed browsers path is Genie's own environment once a set is installed (`applyPlaywrightEnv`); when the workspace
 * uses Playwright, has "Use Genie's Playwright server" on, and Genie has that version's browsers, the server's endpoint too —
 * started now if it is not running. A worktree it finds without a node_modules is linked to its main checkout's, when the
 * lockfiles are identical. Whatever it will not do it says, in `GENIE_PLAYWRIGHT_NOTE`.
 */

export const PLAYWRIGHT_NOTE_ENV = 'GENIE_PLAYWRIGHT_NOTE';

export interface PlaywrightHostDeps {
    readonly toolchainDir: string;
    readonly server: PlaywrightServerPorts;
    readonly workspacePath: (workspaceId: string) => string | null;
    /** The workspace's "Use Genie's Playwright server" (`playwright_server`), on by default. */
    readonly optIn: (workspaceId: string) => boolean;
    readonly fs: Pick<PhpVersionsFs, 'exists' | 'readText' | 'list' | 'mkdirp'>;
    readonly link: WorktreeLinkPorts['link'];
    readonly platform: WorktreeLinkPorts['platform'];
}

export class PlaywrightHost {
    readonly #deps: PlaywrightHostDeps;
    readonly server: PlaywrightServer;

    constructor(deps: PlaywrightHostDeps) {
        this.#deps = deps;
        this.server = new PlaywrightServer(deps.server);
    }

    /** The variables for a workspace's agents and terminals: empty when Playwright is not in play for it. */
    envFor(workspaceId: string): Record<string, string> {
        const path = this.#deps.workspacePath(workspaceId);
        if (path === null) return {};
        this.#linkIfWorktree(path);
        const client = projectPlaywrightVersion(path, this.#deps.fs);
        if (client === null) return {};
        const installed = installedVersions({ toolchainDir: this.#deps.toolchainDir, fs: this.#deps.fs });
        const set = resolveBrowserSet(client, installed);
        if (set.kind === 'missing') return { [PLAYWRIGHT_NOTE_ENV]: set.note };
        if (!this.#deps.optIn(workspaceId)) return {};
        // One server runs one version. A different one is not swapped under a running test: the note says why, and the next ask after it idles gets its own.
        const running = this.server.running();
        let endpoint: ServerEndpoint | null = null;
        if (running === null || serverVersionMatch(client, running.version).ok) endpoint = this.server.acquire(client);
        else endpoint = running;
        const { env, note } = playwrightChildEnv({ toolchainDir: this.#deps.toolchainDir, optIn: true, clientVersion: client, server: endpoint });
        return { ...env, ...(note ? { [PLAYWRIGHT_NOTE_ENV]: note } : {}) };
    }

    #linkIfWorktree(path: string): void {
        const main = mainCheckoutOf(path, this.#deps.fs);
        if (main === null) return;
        try {
            linkWorktreeModules(main, path, { platform: this.#deps.platform, fs: this.#deps.fs, link: this.#deps.link });
        } catch {
            // a link that could not be made leaves the worktree as it was: it installs for itself, as before
        }
    }

    dispose(): void {
        void this.server.stop();
    }
}

/**
 * The main checkout a linked worktree belongs to, or `null` for a plain checkout. A worktree's `.git` is a FILE: `gitdir: <main>/.git/worktrees/<name>`,
 * and that folder's `commondir` names the main `.git`.
 */
export function mainCheckoutOf(dir: string, fs: Pick<PhpVersionsFs, 'readText'>): string | null {
    const dotGit = fs.readText?.(join(dir, '.git')) ?? null;
    const m = dotGit === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(dotGit);
    if (!m) return null;
    const gitdir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
    const common = fs.readText?.(join(gitdir, 'commondir'))?.trim();
    if (!common) return null;
    const commonGit = isAbsolute(common) ? common : resolve(gitdir, common);
    return dirname(commonGit);
}

/** Established connections to a local port, asked of the OS (`ss`, then `netstat`); `null` when neither answers. */
export async function osConnections(port: number, platform: string, run: (binary: string, args: readonly string[]) => Promise<{ exitCode: number; stdout: string }>): Promise<number | null> {
    const attempts: ReadonlyArray<readonly [string, readonly string[]]> = platform === 'win32' ? [['netstat', ['-ano', '-p', 'tcp']]] : [['ss', ['-tn']], ['netstat', ['-an']]];
    for (const [binary, args] of attempts) {
        try {
            const r = await run(binary, args);
            const n = r.exitCode === 0 ? countEstablished(r.stdout, port) : -1;
            if (n >= 0) return n;
        } catch {
            // the next one
        }
    }
    return null;
}
