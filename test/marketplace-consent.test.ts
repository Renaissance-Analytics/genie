import { describe, expect, it } from 'vitest';
import type { PluginCapabilities } from '../src/core/plugins.js';
import { needsMarketplaceConsent, compareMarketplaceVersions } from '../src/core/marketplace.js';

const caps = (over: Partial<PluginCapabilities> = {}): PluginCapabilities => ({ network: { hosts: ['api.example.org'] }, genieApi: ['knowledge'], ...over });

describe('C4 consent authority and version precedence', () => {
    it('requires first-install consent even when a package declares no capabilities', async () => {
        expect(needsMarketplaceConsent(null, caps({ network: { hosts: [] }, genieApi: [] }))).toBe(true);
    });

    it('does not re-ask for identical, reordered, duplicate or narrower permissions', async () => {
        const previous = caps({ fs: { scope: 'workspace', extensions: ['.md', '.txt'] }, genieApi: ['knowledge', 'lists'] });
        expect(needsMarketplaceConsent(previous, previous)).toBe(false);
        expect(needsMarketplaceConsent(previous, caps({ fs: { scope: 'workspace', extensions: ['.txt', '.md', '.md'] }, genieApi: ['lists', 'knowledge'] }))).toBe(false);
        expect(needsMarketplaceConsent(previous, caps({ fs: { scope: 'workspace', extensions: ['.md'] }, network: { hosts: [] }, genieApi: [] }))).toBe(false);
    });

    it.each([
        ['a network host', caps({ network: { hosts: ['api.example.org', 'new.example.org'] } })],
        ['a Genie API', caps({ genieApi: ['knowledge', 'manageTerminals'] })],
        ['workspace file access', caps({ fs: { scope: 'workspace', extensions: ['.md'] } })],
    ])('re-asks when an update adds %s', async (_name, next) => {
        expect(needsMarketplaceConsent(caps(), next)).toBe(true);
    });

    it('re-asks for a new file extension; an empty extension list grants no files', async () => {
        expect(needsMarketplaceConsent(caps({ fs: { scope: 'workspace', extensions: ['.md'] } }), caps({ fs: { scope: 'workspace', extensions: ['.md', '.txt'] } }))).toBe(true);
        expect(needsMarketplaceConsent(caps({ fs: { scope: 'workspace', extensions: [] } }), caps({ fs: { scope: 'workspace', extensions: ['.md'] } }))).toBe(true);
    });

    it.each([
        ['1.10.0', '1.9.0'], ['2.0.0', '2.0.0-rc.10'], ['2.0.0-beta.10', '2.0.0-beta.2'],
        ['2.0.0-alpha.x', '2.0.0-alpha.9'], ['10000000000000001.0.0', '10000000000000000.0.0'],
    ])('compares %s above %s by SemVer precedence', async (higher, lower) => {
        expect(compareMarketplaceVersions(higher, lower)).toBeGreaterThan(0);
        expect(compareMarketplaceVersions(lower, higher)).toBeLessThan(0);
    });

    it('ignores build metadata in precedence and refuses malformed versions', async () => {
        expect(compareMarketplaceVersions('1.0.0+build.7', '1.0.0+other')).toBe(0);
        for (const invalid of ['1.0', '01.0.0', '1.0.0-01', '../1.0.0', '1.0.0+']) {
            expect(() => compareMarketplaceVersions(invalid, '1.0.0')).toThrow(/version|semver/i);
        }
    });
});
