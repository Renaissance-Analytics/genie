import type { DeckItem } from '../core/deck.js';
import { MANAGED_BROWSERS, PLAYWRIGHT_NOTICE_DECK_PREFIX, PLAYWRIGHT_STABLE, launchInstall, playwrightDirs } from '../core/playwright-managed.js';
import { projectPlaywrightVersion, readManifest, readyOnDisk, type PlaywrightInstallOutcome } from './playwright-browsers.js';
import type { PlaywrightToolPort } from './mcp-tools-playwright.js';
import type { PhpVersionsFs } from './php-versions.js';

/**
 * GENIE INSTALLS THE PLAYWRIGHT BROWSERS ITSELF (Tynn #846). The owner, 2026-11-17: "agents need to use what is installed.
 * genie should have been able to install it. I had to click the install button."
 *
 * One installer in genie-host, the process that is always running: the stable version at launch when Genie has no set,
 * a version a workspace's lockfile pins when an agent or terminal starts there, and a version an agent asks for. One
 * install at a time; an ask for a version already being installed waits for that same install. Progress goes to the log,
 * quietly; a failure is a Deck item (Retry, Dismiss), and the next install of that version that works takes it away.
 */

export interface PlaywrightInstallerPorts {
    /** Install a version's browsers (main/playwright-browsers.ts `installPlaywrightBrowsers`, consent given: Genie's own toolchain). */
    readonly install: (version: string, browsers: readonly string[]) => Promise<PlaywrightInstallOutcome>;
    /** The versions whose browsers are really on disk now. */
    readonly ready: () => readonly string[];
    /** Whether Genie installs by itself (`GENIE_PLAYWRIGHT_AUTO_INSTALL`). */
    readonly enabled: () => boolean;
    /** A set was installed: point what Genie starts from now on at it (`applyPlaywrightEnv`). */
    readonly onInstalled: (version: string) => void;
    readonly now: () => number;
    readonly log?: (line: string) => void;
}

interface Failure {
    readonly version: string;
    readonly browsers: readonly string[];
    readonly reason: string;
    readonly at: number;
}

const ok = (o: PlaywrightInstallOutcome): o is Extract<PlaywrightInstallOutcome, { kind: 'installed' | 'already-installed' }> => o.kind === 'installed' || o.kind === 'already-installed';

export class PlaywrightInstaller {
    readonly #ports: PlaywrightInstallerPorts;
    /** The one line installs wait in: each starts when the one before it has ended. */
    #line: Promise<unknown> = Promise.resolve();
    readonly #running = new Map<string, { readonly version: string; readonly done: Promise<PlaywrightInstallOutcome> }>();
    readonly #failures = new Map<string, Failure>();
    readonly #listeners = new Set<() => void>();

    constructor(ports: PlaywrightInstallerPorts) {
        this.#ports = ports;
    }

    /** Whether Genie installs by itself here: at launch, and for a version a project pins. An agent's own ask is installed either way. */
    byItself(): boolean {
        return this.#ports.enabled();
    }

    /** At launch: the stable version, when Genie has no set and installing by itself is on. `null` when nothing was started. */
    async ensureAtLaunch(): Promise<PlaywrightInstallOutcome | null> {
        const version = launchInstall({ enabled: this.#ports.enabled(), ready: this.#ports.ready() });
        if (version === null) return null;
        return this.ensure(version);
    }

    /** Install a version's browsers now, or wait for the install of it already running. */
    ensure(version: string, browsers: readonly string[] = MANAGED_BROWSERS): Promise<PlaywrightInstallOutcome> {
        const key = `${version}|${[...browsers].sort().join(',')}`;
        const running = this.#running.get(key);
        if (running) return running.done;
        const done = this.#line.then(() => this.#install(version, browsers));
        this.#line = done.catch(() => undefined);
        this.#running.set(key, { version, done });
        this.#changed();
        void done.then(() => { this.#running.delete(key); this.#changed(); }, () => { this.#running.delete(key); this.#changed(); });
        return done;
    }

    async #install(version: string, browsers: readonly string[]): Promise<PlaywrightInstallOutcome> {
        this.#ports.log?.(`playwright: installing Playwright ${version}'s ${browsers.join(', ')}`);
        let outcome: PlaywrightInstallOutcome;
        try {
            outcome = await this.#ports.install(version, browsers);
        } catch (error) {
            outcome = { kind: 'not-installed', reason: error instanceof Error ? error.message : String(error) };
        }
        if (ok(outcome)) {
            this.#failures.delete(version);
            this.#ports.onInstalled(version);
            this.#ports.log?.(`playwright: Playwright ${version}'s browsers are installed`);
        } else {
            const reason = outcome.reason;
            this.#failures.set(version, { version, browsers, reason, at: this.#ports.now() });
            this.#ports.log?.(`playwright: Playwright ${version}'s browsers were not installed: ${reason}`);
        }
        this.#changed();
        return outcome;
    }

    /** The versions being installed (or waiting their turn) now. */
    installing(): string[] {
        return [...new Set([...this.#running.values()].map((r) => r.version))];
    }

    /** The failed installs, as Deck items: Genie's own (no agent behind them), with Retry and Dismiss. */
    items(): DeckItem[] {
        return [...this.#failures.values()].map((f) => ({
            id: `${PLAYWRIGHT_NOTICE_DECK_PREFIX}${f.version}`,
            source: 'genie',
            agentId: null,
            agentName: null,
            workspaceId: null,
            title: `Genie could not install Playwright ${f.version}’s browsers`,
            blocking: false,
            priority: 'normal',
            at: f.at,
            answer: { kind: 'inline', options: [{ id: 'retry', label: 'Retry', tone: 'neutral' }, { id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] },
            forwardedFrom: null,
            detail: `${f.reason}. Agents’ Playwright tests need them; Retry installs them again.`,
        }));
    }

    /** Retry: install that version again. `false` for an item that is not there; the item stays, with the new reason, when it fails again. */
    async retry(id: string): Promise<boolean> {
        const failure = this.#failures.get(id.slice(PLAYWRIGHT_NOTICE_DECK_PREFIX.length));
        if (!id.startsWith(PLAYWRIGHT_NOTICE_DECK_PREFIX) || !failure) return false;
        await this.ensure(failure.version, failure.browsers);
        return true;
    }

    dismiss(id: string): boolean {
        if (!id.startsWith(PLAYWRIGHT_NOTICE_DECK_PREFIX)) return false;
        const gone = this.#failures.delete(id.slice(PLAYWRIGHT_NOTICE_DECK_PREFIX.length));
        if (gone) this.#changed();
        return gone;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        for (const listener of [...this.#listeners]) {
            try {
                listener();
            } catch {
                // a listener's failure is its own
            }
        }
    }
}

/** What the `playwright` tool reads and asks (main/mcp-tools-playwright.ts): the disk, the installer, the caller's workspace. */
export function playwrightToolPort(input: {
    readonly toolchainDir: string;
    readonly fs: Pick<PhpVersionsFs, 'readText' | 'list'>;
    readonly installer: Pick<PlaywrightInstaller, 'ensure' | 'installing' | 'byItself'>;
    readonly workspacePath: (workspaceId: string) => string | null;
}): PlaywrightToolPort {
    const disk = { toolchainDir: input.toolchainDir, fs: input.fs };
    const ready = (): string[] => readyOnDisk(disk).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return {
        status: (workspaceId) => {
            const versions = ready();
            const sets = readManifest(disk);
            const path = input.workspacePath(workspaceId);
            return {
                stable: PLAYWRIGHT_STABLE,
                installed: versions.map((version) => ({ version, browsers: sets[version] ?? [] })),
                browsersPath: versions.length > 0 ? playwrightDirs(input.toolchainDir).browsers : null,
                project: path === null ? null : projectPlaywrightVersion(path, input.fs),
                installing: input.installer.installing(),
                autoInstall: input.installer.byItself(),
            };
        },
        ready,
        held: (version) => (ready().includes(version) ? readManifest(disk)[version] ?? [] : []),
        install: (version, browsers) => input.installer.ensure(version, browsers),
    };
}
