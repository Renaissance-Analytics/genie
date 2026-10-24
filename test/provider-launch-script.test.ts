import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerLaunchOptions } from '../src/main/session-host.js';

/**
 * A CONFIGURED PROVIDER THAT IS A SCRIPT, UNDER PRISM-ACP 0.21.1 (CI's real-window smoke, 2026-10-21: the stub codex
 * `scripts/stub-codex.mjs` never started — "Codex app-server startup failed (ProcessTreeError)"). 0.21 spawns a provider
 * directly, never through a shell, and says how to run a script: name the interpreter and pass the script first —
 * `{ binary: process.execPath, binaryArgs: ['/abs/stub.mjs'] }`. Inside Electron the interpreter is Electron itself, run as
 * Node (`ELECTRON_RUN_AS_NODE=1`, given to that provider only). A real binary is passed as it always was.
 */

const electron = { execPath: '/opt/Genie/genie', electron: true };
const node = { execPath: '/usr/bin/node', electron: false };
beforeEach(() => { vi.stubEnv('NPM_CONFIG_PREFIX', undefined); vi.stubEnv('PHP_INI_SCAN_DIR', undefined); });
afterEach(() => vi.unstubAllEnvs());

describe('a configured script', () => {
    it('runs as the runtime with the script first; in Electron, as Node — the variable allowed through to it alone', () => {
        expect(providerLaunchOptions('/w/genie/scripts/stub-codex.mjs', {}, electron)).toEqual({
            binary: '/opt/Genie/genie',
            binaryArgs: ['/w/genie/scripts/stub-codex.mjs'],
            parentEnv: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
            allowEnv: ['ELECTRON_RUN_AS_NODE'],
        });
    });

    it('a .js or .cjs script too; outside Electron, plain node and no extra variable', () => {
        expect(providerLaunchOptions('C:\\stubs\\claude.cjs', {}, node)).toEqual({ binary: '/usr/bin/node', binaryArgs: ['C:\\stubs\\claude.cjs'] });
        expect(providerLaunchOptions('/s/x.js', {}, node)).toMatchObject({ binaryArgs: ['/s/x.js'] });
    });

    it('the workspace’s service variables still reach it, beside the run-as-Node one', () => {
        const out = providerLaunchOptions('/s/stub.mjs', { DB_PORT: '5433' }, electron);
        expect(out.parentEnv).toMatchObject({ DB_PORT: '5433', ELECTRON_RUN_AS_NODE: '1' });
        expect(out.allowEnv).toEqual(['DB_PORT', 'ELECTRON_RUN_AS_NODE']);
    });
});

describe('CONTROL: everything else is as it was', () => {
    it('a real binary is the binary, no args, no extra variable', () => {
        expect(providerLaunchOptions('/usr/local/bin/codex', {}, electron)).toEqual({ binary: '/usr/local/bin/codex' });
        expect(providerLaunchOptions('C:\\Users\\wish\\AppData\\Roaming\\npm\\claude.cmd', {}, electron)).toEqual({ binary: 'C:\\Users\\wish\\AppData\\Roaming\\npm\\claude.cmd' });
    });

    it('nothing configured: the provider’s default, with the service variables only', () => {
        expect(providerLaunchOptions(undefined, {}, electron)).toEqual({});
        expect(providerLaunchOptions(undefined, { DB_PORT: '5433' }, electron)).toMatchObject({ allowEnv: ['DB_PORT'] });
    });
});
