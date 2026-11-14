import { describe, expect, it } from 'vitest';
import { connectableWorkstations } from '../src/main/tynn-network.js';
import { workstationOpenFrom } from '../src/core/tynn-sign-in.js';

/**
 * A host reached by a share link is session-only (Tynn #724; security: a redeemed link is a pass, never a durable share).
 * It is opened through the link's own handoff, and never joins the list of the account's hosts.
 */

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const listed = async (rows: unknown[]) => {
    const result = await connectableWorkstations(async () => json(200, { workstations: rows }), new Set());
    return result.ok ? result.workstations.map((w) => w.id) : [];
};

describe('the hosts list holds the account’s hosts, not a link pass (Tynn #724)', () => {
    it('a redeemed share link (session_only) is not listed', async () => {
        const rows = [{ id: 'ws_link', name: 'Lee’s desk', status: 'active', is_local: true, connectable: true, source: 'share', share_origin: 'link', session_only: true }];
        expect(await listed(rows)).toEqual([]);
    });

    it('CONTROL: your own machine, a durable share and an older Tynn that does not say stay listed', async () => {
        const rows = [
            { id: 'ws_mine', name: 'mine', status: 'active', is_local: true, connectable: true, source: 'owner', share_origin: null, session_only: false },
            { id: 'ws_invite', name: 'invited', status: 'active', is_local: true, connectable: true, source: 'share', share_origin: 'invite', session_only: false },
            { id: 'ws_old', name: 'old tynn', status: 'active', is_local: true, connectable: true, source: 'share' },
        ];
        expect(await listed(rows)).toEqual(['ws_mine', 'ws_invite', 'ws_old']);
    });

    it('a mixed list drops only the pass', async () => {
        const rows = [
            { id: 'ws_mine', name: 'mine', status: 'active', is_local: true, connectable: true, source: 'owner', session_only: false },
            { id: 'ws_link', name: 'Lee’s desk', status: 'active', is_local: true, connectable: true, source: 'share', session_only: true },
        ];
        expect(await listed(rows)).toEqual(['ws_mine']);
    });
});

describe('the handoff link opens the whole workstation or one workspace', () => {
    it('a whole-workstation link (no workspace) is a workstation link', () => {
        expect(workstationOpenFrom('genie://workstation/open?id=ws_01abc&name=AlphaR')).toEqual({ id: 'ws_01abc', workspace: null, name: 'AlphaR' });
    });
});
