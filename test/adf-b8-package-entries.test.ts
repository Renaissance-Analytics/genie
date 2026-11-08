import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDecision } from '../src/core/plugins.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import { PluginHost } from '../src/main/plugin-host.js';

/**
 * ADF B8 (Tynn #458), THE HOST'S SIDE OF THE PAGE. Each entry says who published the package, what it adds and what it may
 * touch, read from its manifest, so a disabled or refused package (which has left the catalog) still says. A package that
 * can't load says why in ONE sentence, with the fix. A change the host refuses reaches the page as a failure.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-b8-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const manifest = {
    id: 'com.example.notes', name: 'Notes', version: '1.0.0', publisher: { name: 'Example Co', keyId: 'sha256:unknown' },
    mcpTools: [{ name: 'append', description: 'Append.', inputSchema: { type: 'object' }, run: 'tool.mjs', process: 'subprocess', gated: false }],
    editors: [{ id: 'deck', title: 'Deck', extensions: ['.pptx'], fancyEditor: { export: 'DeckEditor' } }],
    panels: [{ id: 'board', title: 'Board', fancyComponent: { export: 'Callout' } }],
    capabilities: { fs: { scope: 'workspace', extensions: ['.md'] }, network: { hosts: ['api.example.com'] }, genieApi: ['knowledge.search'] },
};
const open = async (publisherChecksOff: boolean) => {
    await mkdir(join(dir, 'notes'), { recursive: true });
    await writeFile(join(dir, 'notes', 'genie-plugin.json'), JSON.stringify(manifest));
    return PluginHost.open({ dir, keys: {}, publisherChecksOff });
};
const summary = { publisher: 'Example Co', adds: { tools: ['append'], panels: ['Board'], editors: ['Deck'] }, touches: { files: ['.md'], network: ['api.example.com'], genieApi: ['knowledge.search'] } };

describe('each entry says who it is from, what it adds and what it may touch', () => {
    it('an enabled package', async () => {
        expect((await open(true)).list()[0]).toMatchObject({ state: 'enabled', ...summary });
    });

    it('a disabled package still says, though it has left the catalog', async () => {
        const host = await open(true);
        await host.setEnabled('com.example.notes', false);
        expect(host.list()[0]).toMatchObject({ state: 'disabled', ...summary });
    });

    it('a refused package still says who it is from and what it wanted', async () => {
        expect((await open(false)).list()[0]).toMatchObject({ state: 'refused', ...summary });
    });

    it('a package with no file access says none', async () => {
        await mkdir(join(dir, 'plain'), { recursive: true });
        await writeFile(join(dir, 'plain', 'genie-plugin.json'), JSON.stringify({ id: 'com.example.plain', name: 'Plain', version: '1.0.0', publisher: { name: 'P', keyId: 'k' } }));
        const host = await PluginHost.open({ dir, keys: {}, publisherChecksOff: true });
        expect(host.list().find((p) => p.id === 'com.example.plain')).toMatchObject({ adds: { tools: [], panels: [], editors: [] }, touches: { files: null, network: [], genieApi: [] } });
    });
});

describe('a package that cannot load says why in one sentence, with the fix', () => {
    const oneSentence = (reason: string) => expect(reason, reason).not.toMatch(/\. [A-Z]/);

    it('unsigned: refused, and how to run it anyway', () => {
        const d = installDecision({ signed: false, tampered: false, reason: 'no signature file (genie-plugin.sig) beside the manifest' }, { publisherChecksOff: false });
        if (d.install) throw new Error('installed');
        oneSentence(d.reason);
        expect(d.reason).toMatch(/turn off publisher checks/);
    });

    it('tampered: refused, and what to do about it', () => {
        const d = installDecision({ signed: false, tampered: true, reason: 'the signature does not match the package' }, { publisherChecksOff: true });
        if (d.install) throw new Error('installed');
        oneSentence(d.reason);
        expect(d.reason).toMatch(/refused as tampered/);
        expect(d.reason).toMatch(/reinstall it/);
    });
});

describe('a change the host refuses reaches the page as a failure', () => {
    const services = (changed: boolean) => ({ plugins: { setEnabled: async () => changed, setNetworkAllowed: async () => changed } }) as never;

    it('setEnabled answered false throws, in words', async () => {
        await expect(handleFeatureAction(services(false), { kind: 'plugins.setEnabled', id: 'com.example.notes', enabled: true })).rejects.toThrow(/com\.example\.notes/);
    });

    it('setNetworkAllowed answered false throws, in words', async () => {
        await expect(handleFeatureAction(services(false), { kind: 'plugins.setNetworkAllowed', id: 'com.example.notes', allowed: true })).rejects.toThrow(/com\.example\.notes/);
    });
});
