import { describe, expect, it } from 'vitest';
import { CATALOG_SCHEMA_VERSION } from '../src/core/catalog.js';
import { REMOTE_PROTOCOL, REMOTE_PROTOCOL_MIN } from '../src/core/remote-protocol.js';
import { LEGACY_OFFER, capability, catalogCapability, elementCapability, negotiate, offerOf, parseCapability, remoteOffer, supports } from '../src/core/protocol-version.js';

/*
 * THE NEGOTIATION, PURE (Tynn #894). Both sides run the same function over the two offers, so they agree without a third
 * message. Capabilities are `name@level`: a side that says `x@3` speaks levels 1..3 of x, and the pair uses the lower.
 * The names and levels are the ADF catalog's: `catalog@<CATALOG_SCHEMA_VERSION>`, and an element as `<id>@<major>`.
 */

describe('reading an offer', () => {
    it('a peer that says nothing is an older Genie: protocol 1, minimum 1, no capabilities', () => {
        expect(LEGACY_OFFER).toEqual({ protocol: 1, minProtocol: 1, capabilities: [] });
        expect(offerOf({})).toEqual(LEGACY_OFFER);
        expect(offerOf({ protocol: 'two' })).toEqual(LEGACY_OFFER);
    });

    it('keeps well-formed capabilities and drops the rest, never throwing', () => {
        const o = offerOf({ protocol: 2, minProtocol: 1, capabilities: ['a@1', 'b', 7, 'c@0', 'd@2', 'e@x', 'f@1.5'] });
        expect(o).toEqual({ protocol: 2, minProtocol: 1, capabilities: ['a@1', 'd@2'] });
        expect(offerOf({ protocol: 2, capabilities: 'a@1' }).capabilities).toEqual([]);
    });

    it('a minimum above its own protocol, or a non-integer, is not believed', () => {
        expect(offerOf({ protocol: 2, minProtocol: 5 })).toMatchObject({ protocol: 2, minProtocol: 2 });
        expect(offerOf({ protocol: 2.5 })).toEqual(LEGACY_OFFER);
    });

    it('a flood of capabilities is cut at 256', () => {
        expect(offerOf({ protocol: 2, capabilities: Array.from({ length: 1000 }, (_, i) => `c${i}@1`) }).capabilities).toHaveLength(256);
    });
});

describe('capability names are the ADF catalog’s', () => {
    it('name@level both ways', () => {
        expect(capability('unsupported-result', 1)).toBe('unsupported-result@1');
        expect(parseCapability('genie.updater@2')).toEqual({ name: 'genie.updater', level: 2 });
        expect(parseCapability('nope')).toBeNull();
    });

    it('the catalog schema is a capability at its own version', () => {
        expect(catalogCapability()).toBe(`catalog@${CATALOG_SCHEMA_VERSION}`);
    });

    it('an element is its id at its version’s major', () => {
        expect(elementCapability({ id: 'genie.updater', version: '1.4.2' })).toBe('genie.updater@1');
        expect(elementCapability({ id: 'genie.tynn', version: '3.0.0-beta.1' })).toBe('genie.tynn@3');
        // Major 0 is still level 1 of that element: a level is never 0.
        expect(elementCapability({ id: 'x.y', version: '0.9.0' })).toBe('x.y@1');
    });

    it('this build’s remote offer: the current protocol, the floor, and the capabilities it speaks', () => {
        const o = remoteOffer();
        expect(o.protocol).toBe(REMOTE_PROTOCOL);
        expect(o.minProtocol).toBe(REMOTE_PROTOCOL_MIN);
        expect(REMOTE_PROTOCOL_MIN).toBeLessThanOrEqual(REMOTE_PROTOCOL);
        expect(o.capabilities).toEqual(expect.arrayContaining(['unsupported-result@1', catalogCapability()]));
    });
});

describe('negotiate', () => {
    const me = { protocol: 3, minProtocol: 2, capabilities: ['a@2', 'b@1', 'c@4'] };

    it('the lower protocol, and only capabilities both said, each at the lower level', () => {
        const r = negotiate(me, { protocol: 4, minProtocol: 1, capabilities: ['a@1', 'c@9', 'z@1'] });
        expect(r).toEqual({ ok: true, negotiated: { protocol: 3, capabilities: ['a@1', 'c@4'] } });
        if (r.ok) {
            expect(supports(r.negotiated, 'a')).toBe(true);
            expect(supports(r.negotiated, 'a', 2)).toBe(false);
            expect(supports(r.negotiated, 'b')).toBe(false);
            expect(supports(r.negotiated, 'z')).toBe(false);
        }
    });

    it('is the same answer from either side', () => {
        const other = { protocol: 4, minProtocol: 1, capabilities: ['a@1', 'c@9', 'z@1'] };
        const a = negotiate(me, other);
        const b = negotiate(other, me);
        expect(a.ok && b.ok && a.negotiated).toEqual(b.ok && b.negotiated);
    });

    it('a peer below my floor is refused, naming both versions', () => {
        const r = negotiate(me, LEGACY_OFFER);
        expect(r).toMatchObject({ ok: false, code: 'version', peerTooOld: true });
        if (!r.ok) { expect(r.reason).toMatch(/\b1\b/); expect(r.reason).toMatch(/\b2\b/); }
    });

    it('a peer whose floor is above my protocol refuses me, and I say so the same way', () => {
        const r = negotiate(me, { protocol: 9, minProtocol: 5, capabilities: [] });
        expect(r).toMatchObject({ ok: false, code: 'version', peerTooOld: false });
        if (!r.ok) { expect(r.reason).toMatch(/\b3\b/); expect(r.reason).toMatch(/\b5\b/); }
    });
});
