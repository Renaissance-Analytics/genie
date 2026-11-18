import type { DeckItem } from '../core/deck.js';
import { MANAGED_BROWSERS } from '../core/playwright-managed.js';
import type { PlaywrightInstallOutcome } from './playwright-browsers.js';

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

export class PlaywrightInstaller {
    readonly #ports: PlaywrightInstallerPorts;

    constructor(ports: PlaywrightInstallerPorts) {
        this.#ports = ports;
    }

    /** At launch: the stable version, when Genie has no set and installing by itself is on. `null` when nothing was started. */
    async ensureAtLaunch(): Promise<PlaywrightInstallOutcome | null> {
        void this.#ports;
        return null; // RED: inert stub
    }

    /** Install a version's browsers now, or wait for the install of it already running. */
    async ensure(version: string, browsers: readonly string[] = MANAGED_BROWSERS): Promise<PlaywrightInstallOutcome> {
        void version;
        void browsers;
        return { kind: 'not-installed', reason: 'RED: inert stub' };
    }

    /** The versions being installed (or waiting their turn) now. */
    installing(): string[] {
        return []; // RED: inert stub
    }

    /** The failed installs, as Deck items. */
    items(): DeckItem[] {
        return []; // RED: inert stub
    }

    /** Retry: install that version again. `false` for an item that is not there. */
    async retry(id: string): Promise<boolean> {
        void id;
        return false; // RED: inert stub
    }

    dismiss(id: string): boolean {
        void id;
        return false; // RED: inert stub
    }

    onChange(listener: () => void): () => void {
        void listener;
        return () => {}; // RED: inert stub
    }
}
