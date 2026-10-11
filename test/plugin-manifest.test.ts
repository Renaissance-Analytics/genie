import { describe, expect, it } from 'vitest';
import { bridgeAccess, parseManifest, type PluginManifest } from '../src/core/plugins.js';

/**
 * PLUGINS (§6.7): a plugin is a package with a `genie-plugin.json`. The manifest is STRICT — unknown
 * keys are refused, because "undeclared access does not exist": every capability a plugin may use is
 * declared here and granted at install, and the bridge refuses anything else by name. Nothing is
 * defaulted open: no `network` means no hosts; no `genieApi` means no Genie API.
 */

const good = {
    id: 'com.example.presentation',
    name: 'Presentation',
    version: '1.2.0',
    publisher: { name: 'Example Co', keyId: 'example-2026' },
    engines: { genie: '>=2.0.0' },
    mcpTools: [{ name: 'createDeck', description: 'Generate a deck', inputSchema: { type: 'object' }, run: 'tools', process: 'worker', gated: true }],
    capabilities: { fs: { scope: 'workspace', extensions: ['.pptx'] }, network: { hosts: ['api.example.com'] }, genieApi: ['openFileForUser'] },
};

describe('parseManifest', () => {
    it('accepts a well-formed manifest and fills the closed defaults: no network, no Genie API, no tools', () => {
        const r = parseManifest(good);
        expect(r.ok).toBe(true);
        const m = (r as { ok: true; manifest: PluginManifest }).manifest;
        expect(m.id).toBe('com.example.presentation');
        expect(m.mcpTools[0]).toMatchObject({ name: 'createDeck', process: 'worker', gated: true });
        const minimal = parseManifest({ id: 'com.example.min', name: 'Min', version: '0.1.0', publisher: { name: 'Example Co', keyId: 'k' } });
        expect(minimal).toMatchObject({ ok: true, manifest: { mcpTools: [], capabilities: { network: { hosts: [] }, genieApi: [] } } });
    });

    it('refuses what it cannot vouch for, naming the field: unknown keys, a bad id, a bad version, an unknown process, a tool without a schema', () => {
        expect(parseManifest({ ...good, extra: true })).toEqual({ ok: false, reason: 'unknown key "extra" — undeclared access does not exist; remove it or declare a known capability' });
        expect(parseManifest({ ...good, id: 'Presentation' })).toMatchObject({ ok: false, reason: expect.stringMatching(/^id must be reverse-DNS/) });
        expect(parseManifest({ ...good, version: 'latest' })).toMatchObject({ ok: false, reason: expect.stringMatching(/^version must be semver/) });
        expect(parseManifest({ ...good, mcpTools: [{ ...good.mcpTools[0], process: 'inline' }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/process must be "worker" or "subprocess"/) });
        expect(parseManifest({ ...good, mcpTools: [{ name: 'x', description: 'y', run: 'tools', process: 'worker', gated: true }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/inputSchema/) });
        expect(parseManifest({ ...good, capabilities: { ...good.capabilities, shell: true } })).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown capability "shell"/) });
        expect(parseManifest(null)).toMatchObject({ ok: false });
        expect(parseManifest('{}')).toMatchObject({ ok: false });
    });
});

describe('bridgeAccess — enforced at the bridge, by name', () => {
    const m = (parseManifest(good) as { ok: true; manifest: PluginManifest }).manifest;

    it('allows exactly what is declared and refuses the rest, naming the plugin, the request and the fix', () => {
        expect(bridgeAccess(m, { kind: 'genieApi', name: 'openFileForUser' })).toEqual({ allowed: true });
        expect(bridgeAccess(m, { kind: 'genieApi', name: 'manageTerminals' })).toEqual({ allowed: false, reason: 'com.example.presentation did not declare genieApi "manageTerminals" — undeclared access does not exist; declare it in genie-plugin.json capabilities.genieApi and reinstall' });
        expect(bridgeAccess(m, { kind: 'network', host: 'api.example.com' })).toEqual({ allowed: true });
        expect(bridgeAccess(m, { kind: 'network', host: 'evil.example.net' })).toMatchObject({ allowed: false, reason: expect.stringMatching(/did not declare network host "evil\.example\.net"/) });
        expect(bridgeAccess(m, { kind: 'fs', path: '/w/tynn/deck.pptx', workspacePath: '/w/tynn' })).toEqual({ allowed: true });
        expect(bridgeAccess(m, { kind: 'fs', path: '/w/tynn/notes.md', workspacePath: '/w/tynn' })).toMatchObject({ allowed: false, reason: expect.stringMatching(/\.md is not among the declared extensions/) });
        expect(bridgeAccess(m, { kind: 'fs', path: '/etc/deck.pptx', workspacePath: '/w/tynn' })).toMatchObject({ allowed: false, reason: expect.stringMatching(/outside the workspace/) });
    });

    it('a manifest with no capabilities allows nothing — closed by default', () => {
        const none = (parseManifest({ id: 'com.example.min', name: 'Min', version: '0.1.0', publisher: { name: 'Example Co', keyId: 'k' } }) as { ok: true; manifest: PluginManifest }).manifest;
        expect(bridgeAccess(none, { kind: 'network', host: 'example.com' }).allowed).toBe(false);
        expect(bridgeAccess(none, { kind: 'genieApi', name: 'thumbsUp' }).allowed).toBe(false);
        expect(bridgeAccess(none, { kind: 'fs', path: '/w/tynn/a.txt', workspacePath: '/w/tynn' })).toMatchObject({ allowed: false, reason: expect.stringMatching(/did not declare fs access/) });
    });
});
