import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * A WORKSPACE'S ENV FILE, CHANGED AFTER IT WAS REGISTERED (Tynn #756, PR8). The file name is stamped from the host's default when a
 * workspace is added; a clone whose project.json names another (`workspace.envFile`) needs a way to set it, and to clear it back to
 * the default, that survives a restart.
 */

let dir = '';
const open = async () => { const r = new Registry(new Store(dir)); await r.load({ name: 'alphar', healthy: true }); return r; };
const envFileOf = (r: Registry, id: string) => r.listWorkspaces().find((w) => w.id === id)?.envFile;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-envfile-756-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('Registry.setWorkspaceEnvFile', () => {
    it('sets the file name, and it is the same after the registry is opened again', async () => {
        const r = await open();
        await r.addWorkspace({ id: 'acme', path: '/w/acme', envFile: '.env' });
        expect(await r.setWorkspaceEnvFile('acme', '.env.local')).toEqual({ ok: true });
        expect(envFileOf(r, 'acme')).toBe('.env.local');
        expect(envFileOf(await open(), 'acme')).toBe('.env.local');
    });

    it('null clears it, back to the default every workspace without one has', async () => {
        const r = await open();
        await r.addWorkspace({ id: 'acme', path: '/w/acme', envFile: '.env.local' });
        expect(await r.setWorkspaceEnvFile('acme', null)).toEqual({ ok: true });
        expect(envFileOf(r, 'acme')).toBeUndefined();
    });

    it('refuses a workspace it does not know, and a name that is not a file name inside a folder', async () => {
        const r = await open();
        await r.addWorkspace({ id: 'acme', path: '/w/acme', envFile: '.env' });
        expect(await r.setWorkspaceEnvFile('nowhere', '.env.x')).toMatchObject({ ok: false });
        for (const bad of ['', '../.env', '/etc/.env', 'C:/x/.env', 'sub/.env']) {
            expect(await r.setWorkspaceEnvFile('acme', bad), JSON.stringify(bad)).toMatchObject({ ok: false });
        }
        expect(envFileOf(r, 'acme')).toBe('.env');
    });

    it('CONTROL: a workspace registered with an env file keeps it through a reopen', async () => {
        const r = await open();
        await r.addWorkspace({ id: 'acme', path: '/w/acme', envFile: '.env.local' });
        expect(envFileOf(await open(), 'acme')).toBe('.env.local');
    });
});
