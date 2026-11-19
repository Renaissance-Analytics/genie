import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { connectableWorkstations } from '../src/main/tynn-network.js';
import { TynnWorkstationRows } from '../src/renderer/components/ConnectMenu.js';

/**
 * "YOURS" MEANS THIS ACCOUNT REGISTERED IT (Tynn #757, security). Tynn's `source = owner` is not enough: a share-link
 * visit could leave a record whose owner is the visitor, and the client's machine then sat among the visitor's own
 * workstations. A row is filed as yours only when Tynn says owner AND that this account registered the machine
 * (`registered_by_you`). Everything else is shared, and is labelled and listed apart. A Tynn that does not say is shared:
 * it fails closed.
 */

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const list = async (rows: unknown[]) => {
    const r = await connectableWorkstations(async () => json(200, { workstations: rows }), new Set());
    if (!r.ok) throw new Error(r.reason);
    return r.workstations;
};
const row = (id: string, extra: Record<string, unknown>) => ({ id, name: id, status: 'active', is_local: true, connectable: true, role: 'pilot', ...extra });

describe('the list says which machines are yours', () => {
    it('CONTROL: owner and registered by this account is yours', async () => {
        expect((await list([row('ws_mine', { source: 'owner', registered_by_you: true })]))[0]).toMatchObject({ id: 'ws_mine', mine: true });
    });

    it('owner by Tynn’s word but registered by another account is shared', async () => {
        expect((await list([row('ws_other', { source: 'owner', registered_by_you: false })]))[0]).toMatchObject({ mine: false });
    });

    it('a Tynn that does not say who registered it: shared (fail closed)', async () => {
        expect((await list([row('ws_old', { source: 'owner' })]))[0]).toMatchObject({ mine: false });
    });

    it('a share or a grant is never yours, whatever else it says', async () => {
        const rows = await list([row('ws_share', { source: 'share', registered_by_you: true }), row('ws_grant', { source: 'grant', registered_by_you: true })]);
        expect(rows.map((w) => w.mine)).toEqual([false, false]);
    });
});

describe('the menu files shared machines apart from yours', () => {
    const ws = { ok: true as const, workstations: [
        { id: 'ws_mine', name: 'mine', active: true, connectable: true, local: true, source: 'owner', mine: true, role: 'pilot' as const },
        { id: 'ws_other', name: 'other', active: true, connectable: true, local: true, source: 'owner', mine: false, role: 'pilot' as const },
        { id: 'ws_share', name: 'share', active: true, connectable: true, local: true, source: 'share', mine: false, role: 'drone' as const },
    ] };
    const section = (html: string, name: string) => { const at = html.indexOf(`data-tynn-workstations="${name}"`); if (at < 0) return ''; const rest = html.slice(at); return rest.slice(0, rest.indexOf('</ul>')); };
    const rowOf = (html: string, id: string) => { const at = html.slice(html.indexOf(`data-tynn-workstation-row="${id}"`)); return at.slice(0, at.indexOf('</li>')); };

    it('yours in one list, shared in another headed "Shared with you"', () => {
        const html = renderToStaticMarkup(<TynnWorkstationRows list={ws} onOpenWorkstation={() => {}} />);
        expect(section(html, 'yours')).toContain('data-tynn-workstation-row="ws_mine"');
        expect(section(html, 'yours')).not.toContain('ws_other');
        expect(section(html, 'yours')).not.toContain('ws_share');
        expect(section(html, 'shared')).toContain('data-tynn-workstation-row="ws_other"');
        expect(section(html, 'shared')).toContain('data-tynn-workstation-row="ws_share"');
        expect(html).toContain('Shared with you');
    });

    it('a shared machine is labelled shared, even when Tynn says owner, and offers no role switch', () => {
        const html = renderToStaticMarkup(<TynnWorkstationRows list={ws} onOpenWorkstation={() => {}} onSetRole={async () => ({ ok: true, role: 'drone' })} />);
        expect(rowOf(html, 'ws_other')).toContain('aria-label="Shared with you"');
        expect(rowOf(html, 'ws_other')).not.toContain('data-action="change-role"');
        // CONTROL: your own desktop keeps its switch and no shared label.
        expect(rowOf(html, 'ws_mine')).toContain('data-action="change-role"');
        expect(rowOf(html, 'ws_mine')).not.toContain('Shared with you');
    });
});
