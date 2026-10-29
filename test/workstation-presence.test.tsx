import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { connectableWorkstations } from '../src/main/tynn-network.js';
import { ConnectMenu, TynnWorkstationRows } from '../src/renderer/components/ConnectMenu.js';

/**
 * IS IT ONLINE? (genie#1278 "Agent: add presence"; the owner approved 2026-10-29, q_d50d850f.)
 *
 * The popover and ⌘K listed every machine the same way whether it was on or off: Tynn's `status` is the record's
 * (`active` while the machine is switched off), and nothing said whether its Genie was connected. Tynn now asks the
 * relay (the only place that knows) and says `online: true | false | null` per row. Genie shows it as a small dot —
 * an icon, not words (the owner's reduce-reading rule) — with the words on hover and for a screen reader.
 */

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('connectableWorkstations carries Tynn\'s `online`', () => {
    it('true and false as Tynn says; absent or anything but a boolean is "not known" (null), never a guess', async () => {
        const rows = [
            { id: 'on', name: 'On', status: 'active', is_local: true, connectable: true, source: 'owner', online: true },
            { id: 'off', name: 'Off', status: 'active', is_local: true, connectable: true, source: 'owner', online: false },
            { id: 'unknown', name: 'Unknown', status: 'active', is_local: true, connectable: true, source: 'owner', online: null },
            { id: 'old-tynn', name: 'Old', status: 'active', is_local: true, connectable: true, source: 'owner' },
            { id: 'odd', name: 'Odd', status: 'active', is_local: true, connectable: true, source: 'owner', online: 'yes' },
        ];
        const result = await connectableWorkstations(async () => json(200, { workstations: rows }), new Set());
        expect(result.ok && Object.fromEntries(result.workstations.map((w) => [w.id, w.online]))).toEqual({ on: true, off: false, unknown: null, 'old-tynn': null, odd: null });
    });
});

const LIST = { ok: true as const, workstations: [
    { id: 'ws_on', name: 'Aionima', active: true, connectable: true, local: true, source: 'owner', role: 'pilot' as const, online: true },
    { id: 'ws_off', name: 'Foundation', active: true, connectable: true, local: true, source: 'owner', role: 'drone' as const, online: false },
    { id: 'ws_unknown', name: 'Cloudy', active: true, connectable: true, local: false, source: 'owner', role: 'drone' as const, online: null },
] };
const row = (html: string, id: string) => { const at = html.slice(html.indexOf(`data-tynn-workstation-row="${id}"`)); return at.slice(0, at.indexOf('</li>')); };
/** The visible words of a fragment: tags (and their attributes) removed. */
const visibleText = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

describe('each row shows whether the machine is online: a dot, its words on hover', () => {
    const html = renderToStaticMarkup(<ConnectMenu workstations={LIST} onOpenWorkstation={() => {}} onOpenSurface={() => {}} onRefresh={() => {}} />);

    it('online: a dot marked online, "Online now" on hover and for a screen reader', () => {
        expect(row(html, 'ws_on')).toMatch(/<span[^>]*data-online="online"[^>]*title="Online now"[^>]*aria-label="Online now"/);
    });

    it('offline: a dot marked offline, "Offline" on hover', () => {
        expect(row(html, 'ws_off')).toMatch(/<span[^>]*data-online="offline"[^>]*title="Offline"[^>]*aria-label="Offline"/);
    });

    it('not known: a dot marked unknown that says so, never shown as online or offline', () => {
        expect(row(html, 'ws_unknown')).toMatch(/<span[^>]*data-online="unknown"[^>]*title="Not known whether it is online"/);
    });

    it('an icon, not words: no presence word is visible in the row', () => {
        for (const id of ['ws_on', 'ws_off', 'ws_unknown']) {
            expect(visibleText(row(html, id))).not.toMatch(/online|offline|not known/i);
        }
    });

    it('the dots differ so they can be told apart at a glance (colour)', () => {
        const cls = (id: string) => /data-online="[a-z]+"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*data-online=/.exec(row(html, id));
        const on = cls('ws_on');
        const off = cls('ws_off');
        const unknown = cls('ws_unknown');
        expect(on && off && unknown).toBeTruthy();
        expect(new Set([on![1] ?? on![2], off![1] ?? off![2], unknown![1] ?? unknown![2]]).size).toBe(3);
    });

    it('a list from a Tynn that does not say (no `online` field) shows the not-known dot', () => {
        const old = renderToStaticMarkup(<TynnWorkstationRows list={{ ok: true, workstations: [{ id: 'ws_old', name: 'Old', active: true, connectable: true, local: true, source: 'owner' }] }} />);
        expect(row(old, 'ws_old')).toContain('data-online="unknown"');
    });
});
