import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginHost } from '../src/main/plugin-host.js';

/**
 * THE PLUGIN HOST (§6.7) over a REAL plugins directory. Every folder with a `genie-plugin.json` is
 * listed — valid and signed, valid but unsigned, or invalid — each with its state and the reason, so
 * nothing is silently dropped. Enable/disable is persisted. The host hands the bridge a guard bound to
 * the plugin's declared capabilities; an unknown or disabled plugin has no guard at all.
 */

const pair = generateKeyPairSync('ed25519');
const keys = { 'example-2026': pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const manifest = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, name: id.split('.').pop(), version: '1.0.0', publisher: { name: 'Example Co', keyId: 'example-2026' }, capabilities: { genieApi: ['openFileForUser'], network: { hosts: [] } }, ...extra });

let dir: string;
let plugins: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-plugin-host-'));
    plugins = join(dir, 'plugins');
    const put = async (folder: string, text: string, signIt: boolean) => {
        await mkdir(join(plugins, folder), { recursive: true });
        await writeFile(join(plugins, folder, 'genie-plugin.json'), text);
        if (signIt) await writeFile(join(plugins, folder, 'genie-plugin.sig'), sign(null, Buffer.from(text), pair.privateKey).toString('base64'));
    };
    await put('presentation', manifest('com.example.presentation'), true);
    await put('local-dev', manifest('com.example.localdev'), false);
    await put('broken', JSON.stringify({ id: 'nope', name: 'Broken', version: '1.0.0', publisher: { name: 'x', keyId: 'example-2026' }, shell: true }), true);
    await mkdir(join(plugins, 'not-a-plugin'), { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('PluginHost', () => {
    it('lists every manifest folder with its state and reason; signed+valid is installable, unsigned and invalid are refused (not dropped); folders without a manifest are not plugins', async () => {
        const host = await PluginHost.open({ dir: plugins, keys, developerMode: false });
        expect(host.list().map((p) => ({ id: p.id, state: p.state }))).toEqual([
            { id: 'com.example.presentation', state: 'enabled' },
            { id: 'com.example.localdev', state: 'refused' },
            { id: '(broken)', state: 'invalid' },
        ]);
        expect(host.list()[1]!.reason).toMatch(/^unsigned plugins are not installed/);
        expect(host.list()[2]!.reason).toMatch(/unknown key "shell"/);
        expect(host.list()[0]!.label).toBe('signed by example-2026');
    });

    it('developer mode admits the unsigned one, labelled UNSIGNED', async () => {
        const host = await PluginHost.open({ dir: plugins, keys, developerMode: true });
        expect(host.list().find((p) => p.id === 'com.example.localdev')).toMatchObject({ state: 'enabled', label: 'UNSIGNED — developer mode' });
    });

    it('disable is persisted across a reopen; the guard exists only for an enabled plugin and enforces the declared capabilities by name', async () => {
        const host = await PluginHost.open({ dir: plugins, keys, developerMode: false });
        expect(host.guard('com.example.presentation')!({ kind: 'genieApi', name: 'openFileForUser' })).toEqual({ allowed: true });
        expect(host.guard('com.example.presentation')!({ kind: 'genieApi', name: 'manageTerminals' })).toMatchObject({ allowed: false, reason: expect.stringMatching(/did not declare genieApi "manageTerminals"/) });
        expect(host.guard('com.example.localdev')).toBeNull();
        expect(host.guard('com.nobody.unknown')).toBeNull();

        await host.setEnabled('com.example.presentation', false);
        expect(host.guard('com.example.presentation')).toBeNull();
        const again = await PluginHost.open({ dir: plugins, keys, developerMode: false });
        expect(again.list()[0]).toMatchObject({ id: 'com.example.presentation', state: 'disabled' });
        expect(await again.setEnabled('com.example.localdev', true)).toBe(false);
    });

    it('an empty or missing plugins directory lists nothing and is not an error', async () => {
        const host = await PluginHost.open({ dir: join(dir, 'does-not-exist'), keys, developerMode: false });
        expect(host.list()).toEqual([]);
    });
});
