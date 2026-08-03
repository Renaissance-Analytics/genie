import { describe, expect, it } from 'vitest';
import { parseMarketplaceIndex, validateMarketplaceManifest } from '../manifest';
import { MARKETPLACE_STALE_MS, marketplacesNeedingRefresh } from '../marketplace-refresh';

/**
 * A marketplace INDEX is a directory listing, and a published plugin must be
 * able to appear in it without a sibling entry blocking the view.
 *
 * These cover the two halves of "Genie never noticed the marketplace update":
 *   - the index PARSE (one malformed member used to reject the whole index, so
 *     every later refresh failed identically and the cached list froze), and
 *   - the refresh POLICY (nothing ever re-fetched an index after it was added).
 */

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'com.example.alpha', name: 'Alpha', repo: 'https://example.com/alpha.git', ...over };
}

function index(plugins: unknown[]): Record<string, unknown> {
    return { id: 'com.example.market', name: 'Example Market', plugins };
}

describe('parseMarketplaceIndex — member entries are partitioned, never silently dropped', () => {
    it('keeps every valid member alongside a malformed one, and reports the rejection', () => {
        const raw = index([
            entry(),
            entry({ id: 'com.example.repo-management', name: 'Repo Management', repo: undefined, path: undefined }),
            entry({ id: 'com.example.omega', name: 'Omega', path: 'plugins/omega' }),
        ]);

        const res = parseMarketplaceIndex(raw);
        if (!res.ok) throw new Error(`expected a parsable index, got: ${res.errors.join('; ')}`);

        expect(res.accepted.map((p) => p.id)).toEqual(['com.example.alpha', 'com.example.omega']);
        expect(res.rejected).toHaveLength(1);
        expect(res.rejected[0].id).toBe('com.example.repo-management');
        expect(res.rejected[0].at).toBe('plugins[1]');
        expect(res.rejected[0].errors.join(' ')).toMatch(/repo|path/);
    });

    it('leaves manifest.plugins as the RAW array so a signed index still verifies', () => {
        const bad = entry({ id: 'NOT-REVERSE-DNS' });
        const raw = index([entry(), bad]);

        const res = parseMarketplaceIndex(raw);
        if (!res.ok) throw new Error('expected a parsable index');
        // The signature payload is the index as published — filtering members out
        // of it would change the canonical bytes and break verification.
        expect(res.manifest.plugins).toHaveLength(2);
        expect(res.manifest.plugins[1]).toBe(bad);
    });

    it('rejects the WHOLE index when an index-level field is unusable', () => {
        expect(parseMarketplaceIndex({ id: 'nodots', name: 'X', plugins: [] }).ok).toBe(false);
        expect(parseMarketplaceIndex({ id: 'com.example.m', name: '', plugins: [] }).ok).toBe(false);
        expect(parseMarketplaceIndex({ id: 'com.example.m', name: 'X' }).ok).toBe(false);
        expect(parseMarketplaceIndex({ id: 'com.example.m', name: 'X', plugins: {} }).ok).toBe(false);
        expect(parseMarketplaceIndex('nope').ok).toBe(false);
    });

    it('accepts a wholly-valid index with nothing rejected', () => {
        const res = parseMarketplaceIndex(index([entry(), entry({ id: 'com.example.beta', name: 'Beta' })]));
        if (!res.ok) throw new Error('expected a parsable index');
        expect(res.rejected).toEqual([]);
        expect(res.accepted).toHaveLength(2);
    });

    it('rejects duplicate member ids rather than installing an ambiguous one', () => {
        const res = parseMarketplaceIndex(index([entry(), entry()]));
        if (!res.ok) throw new Error('expected a parsable index');
        expect(res.accepted.map((p) => p.id)).toEqual(['com.example.alpha']);
        expect(res.rejected).toHaveLength(1);
        expect(res.rejected[0].errors.join(' ')).toMatch(/duplicat/i);
    });
});

describe('validateMarketplaceManifest — the STRICT contract is unchanged', () => {
    it('fails the whole index when any member is malformed', () => {
        const res = validateMarketplaceManifest(index([entry(), entry({ id: 'com.example.b', name: 'B', repo: undefined })]));
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.errors.join(' ')).toMatch(/plugins\[1\]/);
    });

    it('passes a wholly-valid index', () => {
        expect(validateMarketplaceManifest(index([entry()])).ok).toBe(true);
    });
});

describe('marketplacesNeedingRefresh — which cached indexes are stale', () => {
    const now = Date.parse('2026-08-02T12:00:00.000Z');
    const at = (ms: number) => new Date(now - ms).toISOString();

    it('re-fetches a marketplace whose index was last read longer ago than the window', () => {
        const rows = [
            { id: 'fresh', updated_at: at(60_000), manifest_json: '{}' },
            { id: 'stale', updated_at: at(MARKETPLACE_STALE_MS + 1), manifest_json: '{}' },
        ];
        expect(marketplacesNeedingRefresh(rows, now, MARKETPLACE_STALE_MS)).toEqual(['stale']);
    });

    it('always re-fetches a marketplace that has no cached index yet', () => {
        const rows = [{ id: 'never', updated_at: at(0), manifest_json: null }];
        expect(marketplacesNeedingRefresh(rows, now, MARKETPLACE_STALE_MS)).toEqual(['never']);
    });

    it('treats an unparseable timestamp as stale rather than skipping it forever', () => {
        const rows = [{ id: 'broken', updated_at: 'not-a-date', manifest_json: '{}' }];
        expect(marketplacesNeedingRefresh(rows, now, MARKETPLACE_STALE_MS)).toEqual(['broken']);
    });

    it('re-fetches everything when the window is zero (an explicit "Refresh all")', () => {
        const rows = [
            { id: 'a', updated_at: at(0), manifest_json: '{}' },
            { id: 'b', updated_at: at(10), manifest_json: '{}' },
        ];
        expect(marketplacesNeedingRefresh(rows, now, 0)).toEqual(['a', 'b']);
    });
});
