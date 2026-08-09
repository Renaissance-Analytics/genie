import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * genie#54 (second half) — clicking a `.md` file in a remote window opens it as a
 * PLUGIN tab (the Document plugin claims `.md`), whose read/write bridge
 * (`plugins.editorRead`/`editorWrite`) resolves the file. `plugins` was NOT among
 * the bridged namespaces, so it fell through to the CLIENT's main and fed the host's
 * POSIX root (`/data/workspaces/…`) to win32 `path.resolve` + `fsp.stat` →
 * `ENOENT … stat 'C:\data\…\AGENTS.md'`. These assert the binary I/O routes to the
 * host (which resolves with its own POSIX `path`), while `editorFor` — which editor
 * to use — stays a CLIENT-registry decision.
 *
 * genie#101 — the SETTINGS → Plugins MANAGEMENT surface (list / enable / setGrant and
 * siblings) resolved against the CLIENT's plugin registry, so a remote window could
 * never view or manage the HOST's plugins — the machine that actually owns the agent
 * abilities. These assert every host-targeting management verb dials the host over
 * the bridge, while the genuinely client-side concerns (which editor claims a file,
 * document conversion, the local folder picker) stay local.
 */
function fakeLocal(request: ReturnType<typeof vi.fn>): GenieApi {
    return {
        remote: {
            request,
            terminalAttach: vi.fn(),
            terminalInput: vi.fn(),
            terminalResize: vi.fn(),
            terminalDetach: vi.fn(),
            controlState: vi.fn().mockResolvedValue({ locked: false }),
            onControl: vi.fn(),
        },
        settings: { get: vi.fn(), set: vi.fn() },
        workspaces: {},
        files: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
        tynn: {},
        tynnHost: {},
        mcp: {},
        plugins: {
            list: vi.fn().mockResolvedValue([]),
            installRepo: vi.fn().mockResolvedValue({ ok: false }),
            installFolder: vi.fn().mockResolvedValue({ ok: false }),
            enable: vi.fn().mockResolvedValue({ ok: false }),
            setGrant: vi.fn().mockResolvedValue({ ok: false }),
            uninstall: vi.fn().mockResolvedValue({ ok: false }),
            marketplaces: vi.fn().mockResolvedValue([]),
            addMarketplace: vi.fn().mockResolvedValue({ ok: false }),
            refreshMarketplace: vi.fn().mockResolvedValue({ ok: false }),
            refreshMarketplaces: vi.fn().mockResolvedValue({ ok: false }),
            removeMarketplace: vi.fn().mockResolvedValue({ ok: false }),
            installMarketplacePlugin: vi.fn().mockResolvedValue({ ok: false }),
            official: vi.fn().mockResolvedValue({ curated: [], bundled: [] }),
            installBundled: vi.fn().mockResolvedValue({ ok: false }),
            recipes: vi.fn().mockResolvedValue([]),
            developerMode: vi.fn().mockResolvedValue({ enabled: false, keys: [] }),
            setDeveloperMode: vi.fn().mockResolvedValue({ ok: false }),
            addTrustedKey: vi.fn().mockResolvedValue({ ok: false }),
            removeTrustedKey: vi.fn().mockResolvedValue({ ok: false }),
            editorRead: vi.fn().mockResolvedValue({ ok: false }),
            editorWrite: vi.fn().mockResolvedValue({ ok: false }),
            editorFor: vi.fn().mockResolvedValue(null),
            convertDocument: vi.fn().mockResolvedValue({ ok: false }),
        },
    } as unknown as GenieApi;
}

const spy = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('makeRemoteBridge — host-sourced plugin editor I/O (genie#54)', () => {
    it('editorRead() reads the plugin file on the HOST, not the client win32 FS', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, base64: 'aGk=' });
        const api = makeRemoteBridge(fakeLocal(request));

        expect(await api.plugins.editorRead('ai.genie.document', '/data/ws', 'AGENTS.md')).toEqual({
            ok: true,
            base64: 'aGk=',
        });
        expect(request).toHaveBeenCalledWith('/api/plugins/editor-read', {
            method: 'POST',
            json: { pluginId: 'ai.genie.document', root: '/data/ws', relPath: 'AGENTS.md' },
        });
    });

    it('editorWrite() writes the plugin file on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request));

        expect(
            await api.plugins.editorWrite('ai.genie.document', '/data/ws', 'AGENTS.md', 'aGk='),
        ).toEqual({ ok: true });
        expect(request).toHaveBeenCalledWith('/api/plugins/editor-write', {
            method: 'POST',
            json: {
                pluginId: 'ai.genie.document',
                root: '/data/ws',
                relPath: 'AGENTS.md',
                base64: 'aGk=',
            },
        });
    });

    it('editorFor() stays LOCAL — which editor to use is the client registry decision', async () => {
        const request = vi.fn();
        const local = fakeLocal(request);
        const api = makeRemoteBridge(local);

        await api.plugins.editorFor('AGENTS.md');
        expect(spy(local.plugins.editorFor)).toHaveBeenCalledWith('AGENTS.md');
        expect(request).not.toHaveBeenCalled();
    });
});

describe('makeRemoteBridge — host-sourced plugin MANAGEMENT (genie#101)', () => {
    it('list() reads the HOST plugin registry, not the client one', async () => {
        const hostPlugins = [{ id: 'a.b.c', name: 'C', sides: { client: false, host: true } }];
        const request = vi.fn().mockResolvedValue({ plugins: hostPlugins });
        const local = fakeLocal(request);
        const api = makeRemoteBridge(local);

        expect(await api.plugins.list()).toEqual(hostPlugins);
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins');
        expect(spy(local.plugins.list)).not.toHaveBeenCalled();
    });

    it('enable() toggles the plugin on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: true });
        const local = fakeLocal(request);
        const api = makeRemoteBridge(local);

        expect(await api.plugins.enable('a.b.c', true)).toEqual({ ok: true, value: true });
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/enable', {
            method: 'POST',
            json: { id: 'a.b.c', enabled: true },
        });
        expect(spy(local.plugins.enable)).not.toHaveBeenCalled();
    });

    it('setGrant() records the capability grant on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: true });
        const local = fakeLocal(request);
        const api = makeRemoteBridge(local);

        expect(await api.plugins.setGrant('a.b.c', 'network', 'api.example.com', true)).toEqual({
            ok: true,
            value: true,
        });
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/set-grant', {
            method: 'POST',
            json: { id: 'a.b.c', category: 'network', key: 'api.example.com', granted: true },
        });
        expect(spy(local.plugins.setGrant)).not.toHaveBeenCalled();
    });

    it('uninstall() removes the plugin from the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: true });
        const api = makeRemoteBridge(fakeLocal(request));

        expect(await api.plugins.uninstall('a.b.c')).toEqual({ ok: true, value: true });
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/uninstall', {
            method: 'POST',
            json: { id: 'a.b.c' },
        });
    });

    it('installRepo() installs onto the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: { id: 'x', name: 'X', version: '1' } });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.installRepo('https://example.com/p.git', 'main');
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/install-repo', {
            method: 'POST',
            json: { url: 'https://example.com/p.git', ref: 'main' },
        });
    });

    it('marketplaces() lists the HOST marketplaces', async () => {
        const markets = [{ id: 'm1', name: 'M1' }];
        const request = vi.fn().mockResolvedValue({ marketplaces: markets });
        const api = makeRemoteBridge(fakeLocal(request));

        expect(await api.plugins.marketplaces()).toEqual(markets);
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/marketplaces');
    });

    it('addMarketplace() adds it on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: { id: 'm', name: 'M', version: '1' } });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.addMarketplace('https://example.com/index.git', 'main');
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/add-marketplace', {
            method: 'POST',
            json: { url: 'https://example.com/index.git', ref: 'main' },
        });
    });

    it('refreshMarketplace() refreshes it on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: { id: 'm', name: 'M', version: '1' } });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.refreshMarketplace('m1');
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/refresh-marketplace', {
            method: 'POST',
            json: { id: 'm1' },
        });
    });

    it('refreshMarketplaces() refreshes stale indexes on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: [] });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.refreshMarketplaces(0);
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/refresh-marketplaces', {
            method: 'POST',
            json: { maxAgeMs: 0 },
        });
    });

    it('removeMarketplace() removes it on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: true });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.removeMarketplace('m1');
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/remove-marketplace', {
            method: 'POST',
            json: { id: 'm1' },
        });
    });

    it('installMarketplacePlugin() installs onto the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: { id: 'p', name: 'P', version: '1' } });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.installMarketplacePlugin('m1', 'p1');
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/install-marketplace-plugin', {
            method: 'POST',
            json: { marketplaceId: 'm1', pluginId: 'p1' },
        });
    });

    it('official() reads the HOST curated + bundled list', async () => {
        const official = { curated: [], bundled: [{ id: 'b', name: 'B', description: '', path: '/p' }] };
        const request = vi.fn().mockResolvedValue({ official });
        const api = makeRemoteBridge(fakeLocal(request));

        expect(await api.plugins.official()).toEqual(official);
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/official');
    });

    it('installBundled() installs the bundled plugin on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: { id: 'b', name: 'B', version: '1' } });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.installBundled('ai.genie.presentation');
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/install-bundled', {
            method: 'POST',
            json: { id: 'ai.genie.presentation' },
        });
    });

    it('developerMode() reads the HOST developer-mode state + trusted keys', async () => {
        const state = { enabled: true, keys: [{ keyId: 'k1', label: 'K' }] };
        const request = vi.fn().mockResolvedValue(state);
        const api = makeRemoteBridge(fakeLocal(request));

        expect(await api.plugins.developerMode()).toEqual(state);
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/developer-mode');
    });

    it('setDeveloperMode() flips it on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: true });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.setDeveloperMode(true);
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/set-developer-mode', {
            method: 'POST',
            json: { enabled: true },
        });
    });

    it('addTrustedKey() registers the key on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: { keyId: 'k1' } });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.addTrustedKey('-----BEGIN-----', 'my key');
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/add-trusted-key', {
            method: 'POST',
            json: { publicKeyPem: '-----BEGIN-----', label: 'my key' },
        });
    });

    it('removeTrustedKey() revokes it on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, value: true });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.plugins.removeTrustedKey('k1');
        expect(request).toHaveBeenCalledWith('/api/desktop/plugins/remove-trusted-key', {
            method: 'POST',
            json: { keyId: 'k1' },
        });
    });

    it('installFolder() stays LOCAL — the folder picker + path are the CLIENT machine', async () => {
        const request = vi.fn();
        const local = fakeLocal(request);
        const api = makeRemoteBridge(local);

        await api.plugins.installFolder();
        expect(spy(local.plugins.installFolder)).toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it('convertDocument() stays LOCAL — the client-side document editor owns conversion', async () => {
        const request = vi.fn();
        const local = fakeLocal(request);
        const api = makeRemoteBridge(local);

        await api.plugins.convertDocument({ to: 'markdown', base64: 'aGk=' });
        expect(spy(local.plugins.convertDocument)).toHaveBeenCalledWith({ to: 'markdown', base64: 'aGk=' });
        expect(request).not.toHaveBeenCalled();
    });
});
