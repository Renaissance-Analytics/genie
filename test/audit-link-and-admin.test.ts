import { describe, expect, it } from 'vitest';
import { mergeWorkstationRead } from '../src/core/connect-machine.js';
import { principalOf, type HostGrant } from '../src/main/relay-grant.js';
import { connectableWorkstations, type TynnWorkstation } from '../src/main/tynn-network.js';

/**
 * PAIRING VS SHARE LINK, the two Genie tests the audit still owed (.ai/plans/genie-2-pairing-vs-link-audit.md, H3 and H4;
 * Tynn's sides are tynn.ai #394 and #393).
 *
 * Written after the behaviour: each was proven non-vacuous by a break probe on CI (the break pushed, the test red, the
 * break reverted), named in the commit.
 */

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('H3: "Connect to my workstations" drops a link-only workstation once its session is over', () => {
    const live = { id: 'ws_link', name: 'Lee’s desk', status: 'active', is_local: false, connectable: true, source: 'share' };
    const mine = { id: 'ws_mine', name: 'my box', status: 'active', is_local: false, connectable: true, source: 'owner' };

    async function read(rows: unknown[]) {
        return connectableWorkstations(async () => json(200, { workstations: rows }), new Set());
    }

    it('listed while the session is live; gone from the next read when Tynn stops listing it, nothing kept from before', async () => {
        const first = await read([live, mine]);
        let shown = mergeWorkstationRead<TynnWorkstation>(null, first).list;
        // CONTROL: while the link's session is live, the workstation is offered.
        expect(shown.ok && shown.workstations.map((w) => w.id)).toEqual(['ws_link', 'ws_mine']);
        // The session ends: Tynn's connectable no longer lists the link machine (tynn.ai #394).
        shown = mergeWorkstationRead(shown, await read([mine])).list;
        expect(shown.ok && shown.workstations.map((w) => w.id)).toEqual(['ws_mine']);
    });

    it('also gone when Tynn still carries the row but without an entitlement (no source, not connectable)', async () => {
        let shown = mergeWorkstationRead<TynnWorkstation>(null, await read([live, mine])).list;
        shown = mergeWorkstationRead(shown, await read([{ ...live, connectable: false, source: null }, mine])).list;
        expect(shown.ok && shown.workstations.map((w) => w.id)).toEqual(['ws_mine']);
    });
});

describe('H4: an org or team admin’s grant is a guest on the host, never the owner', () => {
    const grant = (over: Partial<HostGrant>): HostGrant => ({
        jti: 'j1', sub: 'user_admin', name: 'Admin', source: 'share', capability: 'control', scopes: ['host:all'],
        expiresAt: Date.now() + 60_000, audRole: 'pilot', sourceWorkstationId: null, shareOrigin: 'member', ...over,
    });

    it('the grant Tynn now gives an admin (an explicit share, src = share) reads as isOwner:false, whole host or one workspace', () => {
        expect(principalOf(grant({}))).toEqual({ ok: true, principal: { label: 'Admin', isOwner: false, workspaceId: null, readonly: false } });
        expect(principalOf(grant({ scopes: ['workspace:w1'] }))).toEqual({ ok: true, principal: { label: 'Admin', isOwner: false, workspaceId: 'w1', readonly: false } });
    });

    it('no source but exactly "owner" is the owner: grant, invite, member, admin, empty or missing are guests', () => {
        for (const source of ['grant', 'invite', 'member', 'admin', 'Owner', '', null]) {
            const r = principalOf(grant({ source }));
            expect(r.ok && r.principal.isOwner, String(source)).toBe(false);
        }
    });

    it('CONTROL: the owner’s own grant (src = owner) is the owner', () => {
        expect(principalOf(grant({ source: 'owner' }))).toMatchObject({ ok: true, principal: { isOwner: true, workspaceId: null } });
    });
});
