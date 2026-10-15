import { describe, expect, it } from 'vitest';
import { deckBand, needsYouCount } from '../src/core/deck.js';
import { deckAnswerRoute, resolveDeckAnswer } from '../src/core/deck-resolve.js';
import {
    CA_VALIDITY_MS,
    LEAF_VALIDITY_MS,
    RENEW_MARGIN_MS,
    TRUST_DECK_ID,
    chooseCa,
    leafHosts,
    leafNeed,
    normaliseThumbprint,
    trustAnswer,
    trustDeckItem,
    trustInstallStep,
    trustQuery,
    type CaFacts,
} from '../src/core/gen-ca.js';

/**
 * GENIE'S `.gen` CA — THE PLANNING (core/gen-ca.ts, pure). Which CA (own > Genie 1's > new), when the one leaf is
 * issued again (the host set changed, or it is within 30 days of expiry — and not otherwise), how the OS store is
 * asked about THIS CA (by thumbprint, read-only, an unreadable answer an error rather than a "no"), how trust is
 * installed, and when Genie asks the person (the Deck item) — only when the store said no and a site exists.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 15);
const good: CaFacts = { isCa: true, keyMatches: true, notAfter: NOW + 3000 * DAY };
const THUMB = '0123456789ABCDEF0123456789ABCDEF01234567';

describe('which CA', () => {
    it('own > Genie 1’s (the first usable folder) > new — every combination, counted', () => {
        const cases: Array<[CaFacts | null, Array<CaFacts | null>, string]> = [
            [good, [good], 'own'],
            [good, [], 'own'],
            [null, [good], 'v1:0'],
            [null, [null, good], 'v1:1'],
            [null, [], 'create'],
            [null, [null], 'create'],
        ];
        const got = cases.map(([own, v1]) => {
            const c = chooseCa({ own, v1, now: NOW });
            return c.use === 'v1' ? `v1:${c.index}` : c.use;
        });
        expect(got).toEqual(cases.map((c) => c[2]));
    });

    it('a CA that is not a CA, whose key does not match, or that is within 30 days of expiry is passed over — and the reason is said', () => {
        const notCa = { ...good, isCa: false };
        const wrongKey = { ...good, keyMatches: false };
        const expiring = { ...good, notAfter: NOW + RENEW_MARGIN_MS - 1 };
        expect(chooseCa({ own: notCa, v1: [good], now: NOW })).toEqual({ use: 'v1', index: 0 });
        expect(chooseCa({ own: wrongKey, v1: [good], now: NOW })).toEqual({ use: 'v1', index: 0 });
        expect(chooseCa({ own: expiring, v1: [], now: NOW })).toMatchObject({ use: 'create', why: expect.stringMatching(/within the renewal window/) });
        expect(chooseCa({ own: null, v1: [wrongKey], now: NOW })).toMatchObject({ use: 'create', why: 'Genie 1’s CA\'s key does not match its certificate' });
        expect(chooseCa({ own: null, v1: [], now: NOW })).toEqual({ use: 'create', why: 'no CA on this machine yet' });
        // Positive control at the boundary: one millisecond more than the margin is still usable.
        expect(chooseCa({ own: { ...good, notAfter: NOW + RENEW_MARGIN_MS + 1 }, v1: [], now: NOW })).toEqual({ use: 'own' });
    });

    it('lifetimes are Genie 1’s: the CA ten years, the leaf 397 days (under the 398-day browser cap), renewal 30 days ahead', () => {
        expect(CA_VALIDITY_MS).toBe(3650 * DAY);
        expect(LEAF_VALIDITY_MS).toBe(397 * DAY);
        expect(RENEW_MARGIN_MS).toBe(30 * DAY);
    });
});

describe('the leaf', () => {
    const leaf = { hosts: ['dash.gen', 'tynn.gen'], notAfter: NOW + 300 * DAY, fromCa: true };

    it('names are lowercased, deduped and sorted; a name that is not a .gen hostname is refused', () => {
        expect(leafHosts(['Tynn.gen', 'dash.gen', 'tynn.gen', 'web.acme.gen'])).toEqual(['dash.gen', 'tynn.gen', 'web.acme.gen']);
        expect(() => leafHosts(['example.com'])).toThrow(/not a \.gen hostname/);
        expect(() => leafHosts(['bad name.gen'])).toThrow(/not a \.gen hostname/);
    });

    it('re-issued when missing, from another CA, when the host set changes, or within 30 days of expiry — and NOT otherwise', () => {
        expect(leafNeed({ leaf: null, hosts: ['tynn.gen'], now: NOW })).toBe('missing');
        expect(leafNeed({ leaf: { ...leaf, fromCa: false }, hosts: ['dash.gen', 'tynn.gen'], now: NOW })).toBe('other-ca');
        expect(leafNeed({ leaf, hosts: ['tynn.gen'], now: NOW })).toBe('hosts-changed');
        expect(leafNeed({ leaf, hosts: ['dash.gen', 'tynn.gen', 'docs.gen'], now: NOW })).toBe('hosts-changed');
        expect(leafNeed({ leaf, hosts: ['dash.gen', 'tynn.gen'], now: leaf.notAfter - RENEW_MARGIN_MS })).toBe('expiring');
        // Not otherwise: same set in another order and case, plenty of time left.
        expect(leafNeed({ leaf, hosts: ['TYNN.gen', 'dash.gen'], now: NOW })).toBeNull();
        expect(leafNeed({ leaf, hosts: ['dash.gen', 'tynn.gen'], now: leaf.notAfter - RENEW_MARGIN_MS - 1 })).toBeNull();
    });
});

describe('the trust store, asked by thumbprint', () => {
    it('a thumbprint is forty upper-case hex digits; Node’s colon form is accepted, anything else refused', () => {
        expect(normaliseThumbprint('01:23:45:67:89:ab:cd:ef:01:23:45:67:89:AB:CD:EF:01:23:45:67')).toBe(THUMB);
        expect(() => normaliseThumbprint("x'; Remove-Item C:\\")).toThrow(/not a SHA-1 thumbprint/);
    });

    it('windows: Test-Path on BOTH Root stores by thumbprint, read-only, and only True or False is an answer', () => {
        const q = trustQuery('win32', THUMB);
        expect(q).toEqual({
            kind: 'command',
            command: 'powershell',
            args: ['-NoProfile', '-NonInteractive', '-Command', `(Test-Path -LiteralPath 'Cert:\\LocalMachine\\Root\\${THUMB}') -or (Test-Path -LiteralPath 'Cert:\\CurrentUser\\Root\\${THUMB}')`],
        });
        expect(trustAnswer('win32', 'True\r\n', THUMB)).toBe(true);
        expect(trustAnswer('win32', 'False\r\n', THUMB)).toBe(false);
        expect(() => trustAnswer('win32', 'Test-Path : Cannot find drive.\r\n', THUMB)).toThrow(/not True or False/);
        expect(() => trustAnswer('win32', '', THUMB)).toThrow(/not True or False/);
    });

    it('macOS: the System keychain’s SHA-1 list holds this thumbprint or not (positive and negative control)', () => {
        expect(trustQuery('darwin', THUMB)).toEqual({ kind: 'command', command: 'security', args: ['find-certificate', '-a', '-Z', '/Library/Keychains/System.keychain'] });
        const listing = `SHA-256 hash: AB\nSHA-1 hash: ${THUMB}\nkeychain: "/Library/Keychains/System.keychain"\n`;
        expect(trustAnswer('darwin', listing, THUMB)).toBe(true);
        expect(trustAnswer('darwin', listing.replace(THUMB, 'F'.repeat(40)), THUMB)).toBe(false);
    });

    it('linux: the system bundles are read (no command)', () => {
        expect(trustQuery('linux', THUMB)).toMatchObject({ kind: 'bundles', paths: expect.arrayContaining(['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt']) });
    });
});

describe('installing trust (one elevated step)', () => {
    it('windows certutil into Root; macOS the System keychain as a trusted root; linux update-ca-certificates or p11-kit, the path as $1', () => {
        expect(trustInstallStep('win32', 'C:\\Users\\me\\.genie\\runtime\\gen-ca\\ca.crt')).toEqual({ command: 'certutil', args: ['-addstore', '-f', 'Root', 'C:\\Users\\me\\.genie\\runtime\\gen-ca\\ca.crt'] });
        expect(trustInstallStep('darwin', '/Users/me/.genie/runtime/gen-ca/ca.crt')).toEqual({ command: 'security', args: ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', '/Users/me/.genie/runtime/gen-ca/ca.crt'] });
        const linux = trustInstallStep('linux', "/home/it's me/.genie/runtime/gen-ca/ca.crt");
        expect(linux.command).toBe('/bin/sh');
        expect(linux.args.slice(0, 1)).toEqual(['-c']);
        expect(linux.args.slice(2)).toEqual(['sh', "/home/it's me/.genie/runtime/gen-ca/ca.crt"]);
        expect(linux.args[1]).not.toContain('/home/');
        expect(linux.args[1]).toContain('update-ca-certificates');
        expect(linux.args[1]).toContain('trust anchor --store "$1"');
    });
});

describe('the Deck item (Genie asks once)', () => {
    const ask = { trusted: false as boolean | null, sites: 1, host: 'tynn.gen' as string | null, deferredFor: null as string | null, thumbprint: THUMB, at: NOW };

    it('appears only when the store said untrusted, a site exists, and Not now was not said to THIS CA', () => {
        const item = trustDeckItem(ask);
        expect(item).toMatchObject({ id: TRUST_DECK_ID, source: 'genie', agentId: null, agentName: null, blocking: false, title: 'Trust Genie’s certificate so https://tynn.gen works in your browser' });
        expect(item!.answer).toEqual({ kind: 'inline', options: [{ id: 'trust', label: 'Trust', tone: 'ok' }, { id: 'not-now', label: 'Not now', tone: 'neutral' }] });
        expect(trustDeckItem({ ...ask, trusted: true })).toBeNull();
        expect(trustDeckItem({ ...ask, trusted: null })).toBeNull();
        expect(trustDeckItem({ ...ask, sites: 0 })).toBeNull();
        expect(trustDeckItem({ ...ask, deferredFor: THUMB })).toBeNull();
        // Not now to an OLD CA: a renewed CA asks again.
        expect(trustDeckItem({ ...ask, deferredFor: 'F'.repeat(40) })).not.toBeNull();
        expect(trustDeckItem({ ...ask, host: null })!.title).toBe('Trust Genie’s certificate so https://<name>.gen works in your browser');
    });

    it('it is in the Needs-you band and counted; Trust and Not now resolve to the two feature commands; another genie: id is refused', () => {
        const item = trustDeckItem(ask)!;
        expect(deckBand([item]).map((i) => i.id)).toEqual([TRUST_DECK_ID]);
        expect(needsYouCount([item])).toBe(1);
        expect(resolveDeckAnswer(item, 'trust')).toEqual({ kind: 'trust-certificate' });
        expect(resolveDeckAnswer(item, 'not-now')).toEqual({ kind: 'defer-trust-certificate' });
        expect(resolveDeckAnswer(item, 'maybe')).toEqual({ kind: 'refused', reason: 'maybe is not one of this item’s options' });
        expect(deckAnswerRoute(item, 'trust')).toEqual({ kind: 'feature' });
        expect(resolveDeckAnswer({ ...item, id: 'genie:something-else' }, 'trust')).toEqual({ kind: 'refused', reason: 'genie:something-else is not an item Genie knows how to answer' });
    });
});
