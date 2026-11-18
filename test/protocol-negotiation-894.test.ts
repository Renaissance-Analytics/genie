import { describe, expect, it } from 'vitest';
import { CATALOG_SCHEMA_VERSION } from '../src/core/catalog.js';
import { REMOTE_SCHEMA } from '../src/core/remote-protocol.js';
import {
    LEGACY_OFFER, SECURITY_FLOOR_SCHEMA, SUPPORT_WINDOW_DAYS, capability, catalogCapabilities, catalogCapability, compareTrackBuilds, elementCapability,
    hostUpdate, isSchema, negotiate, offerOf, parseCapability, parseTrackBuild, remoteOffer, schemaMinusDays, supports, windowFloor,
} from '../src/core/protocol-version.js';
import { genieCatalog } from '../src/main/genie-catalog.js';

/*
 * THE NEGOTIATION, PURE (Tynn #894, with the owner's rulings of 2026-11-18):
 *  - every track (client, host, launcher, browser) numbers its builds on its own: `<schema>-<release>[.<hotfix>]`, the
 *    schema a date (`2026.11.18-1`; a hotfix is `-1.1` unless the schema changes);
 *  - compatibility is judged on the SCHEMA within a FIXED window: each side accepts a peer whose schema is no older than
 *    its own minus SUPPORT_WINDOW_DAYS (or a raised security floor);
 *  - capabilities are the ADF catalog's: `catalog@<CATALOG_SCHEMA_VERSION>`, an element as `<id>@<major>`.
 * Both sides run the same function over the two offers, so they agree without a third message.
 */

describe('track builds and schemas', () => {
    it('a build is its schema date, its release and its hotfix', () => {
        expect(parseTrackBuild('2026.11.18-1')).toEqual({ schema: '2026.11.18', release: 1, hotfix: 0 });
        expect(parseTrackBuild('2026.11.18-1.1')).toEqual({ schema: '2026.11.18', release: 1, hotfix: 1 });
        expect(parseTrackBuild('2.0.0-beta.64')).toBeNull();
        expect(parseTrackBuild('2026.13.01-1')).toBeNull();
    });

    it('builds order by schema, then release, then hotfix', () => {
        expect(compareTrackBuilds('2026.11.18-1', '2026.11.18-1.1')).toBeLessThan(0);
        expect(compareTrackBuilds('2026.11.18-2', '2026.11.18-1.9')).toBeGreaterThan(0);
        expect(compareTrackBuilds('2026.12.01-1', '2026.11.30-7')).toBeGreaterThan(0);
        expect(compareTrackBuilds('2026.11.18-1', '2026.11.18-1')).toBe(0);
    });

    it('a schema is a real date; the window counts back in days', () => {
        expect(isSchema('2026.11.18')).toBe(true);
        expect(isSchema('2026.02.30')).toBe(false);
        expect(isSchema('2026.11.18-1')).toBe(false);
        expect(schemaMinusDays('2026.11.18', 30)).toBe('2026.10.19');
        expect(schemaMinusDays('2026.03.01', 1)).toBe('2026.02.28');
    });

    it('the window is fixed: this schema minus SUPPORT_WINDOW_DAYS, unless the security floor is higher', () => {
        expect(SUPPORT_WINDOW_DAYS).toBe(30);
        expect(windowFloor('2026.11.18')).toBe('2026.10.19');
        expect(windowFloor('2026.11.18', '2026.11.01')).toBe('2026.11.01');
        expect(windowFloor('2026.11.18', '2026.01.01')).toBe('2026.10.19');
        // No security floor is raised today: this build's floor is the window's.
        expect(windowFloor(REMOTE_SCHEMA, SECURITY_FLOOR_SCHEMA)).toBe(windowFloor(REMOTE_SCHEMA));
    });
});

describe('reading an offer', () => {
    it('a peer that says no schema is the wire as it was before (legacy): no floor, no capabilities', () => {
        expect(LEGACY_OFFER).toMatchObject({ schema: '2026.11.01', minSchema: '0000.01.01', capabilities: [] });
        expect(offerOf({})).toMatchObject({ schema: LEGACY_OFFER.schema, minSchema: LEGACY_OFFER.minSchema, track: null, build: null });
        expect(offerOf({ protocol: 1, build: '2.0.0-beta.64+0123456789ab' })).toMatchObject({ schema: LEGACY_OFFER.schema, build: '2.0.0-beta.64+0123456789ab' });
        expect(offerOf({ schema: 'tomorrow' }).schema).toBe(LEGACY_OFFER.schema);
    });

    it('keeps the track and build, a floor no newer than its schema, and only well-formed capabilities', () => {
        const o = offerOf({ track: 'host', build: '2026.11.18-2', schema: '2026.11.18', minSchema: '2026.10.19', capabilities: ['a@1', 'b', 7, 'c@0', 'd@2'] });
        expect(o).toEqual({ track: 'host', build: '2026.11.18-2', schema: '2026.11.18', minSchema: '2026.10.19', capabilities: ['a@1', 'd@2'] });
        expect(offerOf({ schema: '2026.11.18', minSchema: '2027.01.01' }).minSchema).toBe('2026.11.18');
        expect(offerOf({ schema: '2026.11.18', track: 'toaster' }).track).toBeNull();
    });

    it('a flood of capabilities is cut at 256', () => {
        expect(offerOf({ schema: '2026.11.18', capabilities: Array.from({ length: 1000 }, (_, i) => `c${i}@1`) }).capabilities).toHaveLength(256);
    });
});

describe('capability names are the ADF catalog’s', () => {
    it('name@level both ways', () => {
        expect(capability('unsupported-result', 1)).toBe('unsupported-result@1');
        expect(parseCapability('genie.updater@2')).toEqual({ name: 'genie.updater', level: 2 });
        expect(parseCapability('nope')).toBeNull();
    });

    it('the catalog schema is a capability at its own version; an element is its id at its major', () => {
        expect(catalogCapability()).toBe(`catalog@${CATALOG_SCHEMA_VERSION}`);
        expect(elementCapability({ id: 'genie.updater', version: '1.4.2' })).toBe('genie.updater@1');
        expect(elementCapability({ id: 'genie.tynn', version: '3.0.0-beta.1' })).toBe('genie.tynn@3');
        expect(elementCapability({ id: 'x.y', version: '0.9.0' })).toBe('x.y@1');
    });

    it('a host offers every element a client draws or links to; host-only ones are not offered', () => {
        expect(catalogCapabilities([
            { id: 'a.both', version: '2.1.0', reach: { side: 'both' } },
            { id: 'b.client', version: '1.0.0', reach: { side: 'client' } },
            { id: 'c.host', version: '1.0.0', reach: { side: 'host' } },
        ])).toEqual(['a.both@2', 'b.client@1']);
        expect(catalogCapabilities(genieCatalog().list())).toContain('genie.updater@1');
    });

    it('this build’s offer: its track, the wire schema, the fixed window’s floor, its capabilities plus any added once', () => {
        const o = remoteOffer('client', '2026.11.18-1', ['genie.updater@1', 'genie.updater@1', 'bad']);
        expect(o).toMatchObject({ track: 'client', build: '2026.11.18-1', schema: REMOTE_SCHEMA, minSchema: windowFloor(REMOTE_SCHEMA, SECURITY_FLOOR_SCHEMA) });
        expect(o.capabilities).toEqual(expect.arrayContaining(['unsupported-result@1', catalogCapability()]));
        expect(o.capabilities.filter((c) => c === 'genie.updater@1')).toHaveLength(1);
        expect(o.capabilities).not.toContain('bad');
    });
});

describe('negotiate', () => {
    const me = { track: 'client' as const, build: null, schema: '2026.11.18', minSchema: '2026.10.19', capabilities: ['a@2', 'b@1', 'c@4'] };

    it('inside the window: the older schema, and only capabilities both said, each at the lower level', () => {
        const r = negotiate(me, { track: 'host', build: null, schema: '2026.11.01', minSchema: '2026.10.02', capabilities: ['a@1', 'c@9', 'z@1'] });
        expect(r).toEqual({ ok: true, negotiated: { schema: '2026.11.01', capabilities: ['a@1', 'c@4'] } });
        if (r.ok) {
            expect(supports(r.negotiated, 'a')).toBe(true);
            expect(supports(r.negotiated, 'a', 2)).toBe(false);
            expect(supports(r.negotiated, 'b')).toBe(false);
        }
    });

    it('is the same answer from either side', () => {
        const other = { track: 'host' as const, build: null, schema: '2026.11.10', minSchema: '2026.10.11', capabilities: ['a@1', 'c@9'] };
        const a = negotiate(me, other);
        const b = negotiate(other, me);
        expect(a.ok && b.ok && a.negotiated).toEqual(b.ok && b.negotiated);
    });

    it('a peer older than my window is outside it, named with both schemas', () => {
        const r = negotiate(me, { track: 'host', build: '2026.10.01-3', schema: '2026.10.01', minSchema: '2026.09.01', capabilities: [] });
        expect(r).toMatchObject({ ok: false, code: 'version', peerTooOld: true });
        if (!r.ok) { expect(r.reason).toContain('2026.10.01'); expect(r.reason).toContain('2026.10.19'); }
    });

    it('a peer whose window has left me behind refuses me, and I say so the same way', () => {
        const r = negotiate(me, { track: 'host', build: null, schema: '2027.01.10', minSchema: '2026.12.11', capabilities: [] });
        expect(r).toMatchObject({ ok: false, code: 'version', peerTooOld: false });
        if (!r.ok) { expect(r.reason).toContain('2026.11.18'); expect(r.reason).toContain('2026.12.11'); }
    });
});

describe('the client detects a host to update', () => {
    const client = { track: 'client' as const, build: '2026.11.18-1', schema: '2026.11.18', minSchema: '2026.10.19', capabilities: [] };

    it('a host on an older schema, inside the window, is offered an update but still works', () => {
        expect(hostUpdate(client, { track: 'host', build: '2026.11.05-2', schema: '2026.11.05', minSchema: '2026.10.06', capabilities: [] })).toMatchObject({ needed: true, compatible: true, hostSchema: '2026.11.05', hostBuild: '2026.11.05-2', windowDays: SUPPORT_WINDOW_DAYS });
    });

    it('a host outside the window needs the update before anything else works', () => {
        expect(hostUpdate(client, { track: 'host', build: null, schema: '2026.09.30', minSchema: '2026.08.31', capabilities: [] })).toMatchObject({ needed: true, compatible: false });
    });

    it('a host on the same or a newer schema needs nothing from this client', () => {
        expect(hostUpdate(client, { ...client, track: 'host' })).toMatchObject({ needed: false, compatible: true });
        expect(hostUpdate(client, { track: 'host', build: null, schema: '2026.11.25', minSchema: '2026.10.26', capabilities: [] })).toMatchObject({ needed: false, compatible: true });
    });

    it('a legacy host (no schema) is offered the update', () => {
        expect(hostUpdate(client, LEGACY_OFFER)).toMatchObject({ needed: true, compatible: true });
    });
});
