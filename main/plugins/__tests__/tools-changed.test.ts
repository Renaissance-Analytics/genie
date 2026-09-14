import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EVERY CHANGE THAT CAN MOVE THE TOOL LIST SAYS SO (genie#346).
 *
 * An enabled, trusted plugin's tools ride Genie's `tools/list`. The in-process
 * server computes that list per request, so a plugin turned on was simply there on
 * the next one. The MCP shuttle serves the list from the manifest Genie last
 * PUBLISHED — so a change nobody announces leaves every agent that connects
 * afterwards with yesterday's tools, and nothing anywhere looks wrong.
 *
 * So each management operation that can change what is enabled or trusted
 * announces it once it has succeeded, and nothing else announces anything.
 */

vi.mock('../../db', () => ({
    listPlugins: vi.fn(() => []),
    getPlugin: vi.fn((id: string) => (id === 'known' ? { id, grants: { fs: {}, network: {}, genieApi: {} } } : null)),
    setPluginEnabled: vi.fn(),
    setPluginGrants: vi.fn(),
    setSettings: vi.fn(),
    getAllSettings: vi.fn(() => ({})),
    listPluginMarketplaces: vi.fn(() => []),
}));
vi.mock('../install', () => ({
    installPluginFromRepo: vi.fn(async () => ({ id: 'p' })),
    installMarketplacePlugin: vi.fn(async () => ({ id: 'p' })),
    uninstallPlugin: vi.fn(),
    addMarketplace: vi.fn(async () => ({ id: 'm' })),
    removeMarketplace: vi.fn(),
    refreshMarketplace: vi.fn(async () => ({ id: 'm' })),
    refreshStaleMarketplaces: vi.fn(async () => []),
    marketplacePlugins: vi.fn(() => []),
    marketplaceIndexIssues: vi.fn(() => []),
    installPluginFromFolder: vi.fn(async () => ({ id: 'p' })),
    revalidateAllPluginTrust: vi.fn(),
}));
vi.mock('../registry', () => ({ disposePlugin: vi.fn() }));
vi.mock('../official', () => ({
    OFFICIAL_PLUGINS: [],
    listBundledPlugins: vi.fn(() => []),
    materialiseBundled: vi.fn(() => ({ path: '/bundled' })),
}));
vi.mock('../consent', () => ({ consentAndEnablePlugin: vi.fn(async () => ({ ok: true })) }));
vi.mock('../recipes', () => ({ listPluginRecipes: vi.fn(() => []) }));
vi.mock('../panels', () => ({ listPluginPanels: vi.fn(() => []) }));
vi.mock('../trust', () => ({
    userTrustedKeys: vi.fn(() => []),
    addUserTrustedKey: vi.fn(() => 'key-1'),
    removeUserTrustedKey: vi.fn(),
}));
vi.mock('../side', () => ({ pluginSides: vi.fn(() => ({})) }));

import * as manage from '../manage';
import * as install from '../install';
import { onPluginToolsChanged } from '../tools-changed';

const announced = vi.fn();
onPluginToolsChanged(announced);

beforeEach(() => {
    announced.mockClear();
});

describe('plugin changes that can move the tool list', () => {
    it.each([
        ['install from a repo', () => manage.pluginsInstallRepo('https://example.test/p.git')],
        ['install from a folder', () => manage.pluginsInstallFolder('/p')],
        ['install from a marketplace', () => manage.pluginsInstallMarketplacePlugin('m', 'p')],
        ['install a bundled plugin', () => manage.pluginsInstallBundled('hello')],
        ['enable', () => manage.pluginsEnable('known', true)],
        ['disable', () => manage.pluginsEnable('known', false)],
        ['uninstall', () => manage.pluginsUninstall('known')],
        ['turn Developer Mode on or off', () => manage.pluginsSetDeveloperMode(true)],
        ['trust a signing key', () => manage.pluginsAddTrustedKey('-----BEGIN PUBLIC KEY-----')],
        ['stop trusting a signing key', () => manage.pluginsRemoveTrustedKey('key-1')],
    ])('%s announces it', async (_name, op) => {
        const result = await op();

        expect(result).toMatchObject({ ok: true });
        expect(announced).toHaveBeenCalledOnce();
    });

    it('a change that FAILED announces nothing', async () => {
        vi.mocked(install.uninstallPlugin).mockImplementationOnce(() => {
            throw new Error('not installed');
        });

        const result = manage.pluginsUninstall('known');

        expect(result).toMatchObject({ ok: false });
        expect(announced).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: reading, and marketplace bookkeeping, announce nothing', async () => {
        manage.pluginsList();
        manage.pluginsMarketplaces();
        await manage.pluginsAddMarketplace('https://example.test/m.git');
        manage.pluginsSetGrant('known', 'fs', 'read', true);

        expect(announced).not.toHaveBeenCalled();
    });
});
