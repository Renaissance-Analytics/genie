import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { managedBrowsersReady, playwrightDirs } from '../src/core/playwright-managed.js';
import { applyPlaywrightEnv, restoreToolchainEnv, type EnvPort, type ToolchainFs } from '../src/main/toolchain-ops.js';
import { sharedProtocol } from '../src/core/genie-protocol.js';

/**
 * THE BETA.64 REGRESSION (Tynn #604): Genie pointed PLAYWRIGHT_BROWSERS_PATH at `<toolchain>/playwright/browsers` for
 * everything it started, before that folder held anything. Every Playwright launch on the machine then failed to find a
 * browser. The rule now: Genie's folder only when a managed set is really there; until then the variable is left as the
 * person had it, and Playwright's own default works as before.
 */

const TC = join('/data', 'genie2-toolchain');
const DIRS = playwrightDirs(TC);
const VAR = 'PLAYWRIGHT_BROWSERS_PATH';

function envPort(initial: Record<string, string> = {}): { env: EnvPort; map: Map<string, string> } {
    const map = new Map(Object.entries(initial));
    return { map, env: { get: (n) => map.get(n), set: (n, v) => void map.set(n, v), unset: (n) => void map.delete(n) } };
}

/** A toolchain folder holding `sets` in its manifest (or no manifest) and `entries` in the browsers folder. */
function fsWith(sets: Record<string, string[]> | null, entries: string[]): ToolchainFs {
    return {
        exists: (p) => (p === DIRS.manifest && sets !== null) || (p === DIRS.browsers && entries.length > 0),
        readText: (p) => (p === DIRS.manifest && sets !== null ? JSON.stringify({ sets }) : null),
        writeText: () => {},
        mkdirp: () => {},
        remove: () => {},
        list: (d) => (d === DIRS.browsers ? entries : []),
    };
}

describe('whether a managed browser set is really there', () => {
    it('is not, with nothing recorded', () => {
        expect(managedBrowsersReady({}, [])).toBe(false);
    });
    it('is, when a recorded browser has its revision folder', () => {
        expect(managedBrowsersReady({ '1.65.1': ['chromium'] }, ['chromium-1194', 'ffmpeg-1011'])).toBe(true);
    });
    it('is, when the revision folder is the headless shell Playwright installs beside chromium', () => {
        expect(managedBrowsersReady({ '1.65.1': ['chromium'] }, ['chromium_headless_shell-1194'])).toBe(true);
    });
    it('is not, when the manifest records a set but the folder holds no browser (an install that never finished)', () => {
        expect(managedBrowsersReady({ '1.65.1': ['chromium'] }, ['.links'])).toBe(false);
    });
    it('is not, when the folder holds only browsers the manifest does not record', () => {
        expect(managedBrowsersReady({ '1.65.1': ['firefox'] }, ['chromium-1194'])).toBe(false);
    });
});

describe('PLAYWRIGHT_BROWSERS_PATH at launch, before anything is spawned', () => {
    it('is NOT set when Genie has no managed browsers (the beta.64 regression)', () => {
        const { env, map } = envPort();
        restoreToolchainEnv({ platform: 'linux', env, fs: fsWith(null, []), dataDir: TC });
        expect(map.has(VAR)).toBe(false);
    });
    it('is NOT set when the manifest records a set but the folder is empty', () => {
        const { env, map } = envPort();
        restoreToolchainEnv({ platform: 'linux', env, fs: fsWith({ '1.65.1': ['chromium'] }, []), dataDir: TC });
        expect(map.has(VAR)).toBe(false);
    });
    it('IS Genie’s folder once a managed set is there (a positive control for the two above)', () => {
        const { env, map } = envPort();
        restoreToolchainEnv({ platform: 'linux', env, fs: fsWith({ '1.65.1': ['chromium'] }, ['chromium-1194']), dataDir: TC });
        expect(map.get(VAR)).toBe(DIRS.browsers);
    });
    it('leaves a person’s own value alone while Genie has no set', () => {
        const { env, map } = envPort({ [VAR]: '/home/someone/pw-browsers' });
        restoreToolchainEnv({ platform: 'linux', env, fs: fsWith(null, []), dataDir: TC });
        expect(map.get(VAR)).toBe('/home/someone/pw-browsers');
    });
    it('removes a value pointing at Genie’s empty folder (carried in from a window started by beta.64)', () => {
        const { env, map } = envPort({ [VAR]: DIRS.browsers });
        restoreToolchainEnv({ platform: 'linux', env, fs: fsWith(null, []), dataDir: TC });
        expect(map.has(VAR)).toBe(false);
    });
});

describe('after an install', () => {
    it('points the variable at the set just installed, without a restart', () => {
        const { env, map } = envPort();
        expect(applyPlaywrightEnv({ env, fs: fsWith({ '1.65.1': ['chromium'] }, ['chromium-1194']), dataDir: TC })).toBe(true);
        expect(map.get(VAR)).toBe(DIRS.browsers);
    });
});

describe('what agents are told', () => {
    it('says the variable is set only once Genie has browsers, and never to install browsers themselves', () => {
        const text = sharedProtocol([], 'files');
        expect(text).toMatch(/PLAYWRIGHT_BROWSERS_PATH[^\n]*only once Genie has installed/);
        expect(text).toMatch(/never run `playwright install`/i);
    });
});
