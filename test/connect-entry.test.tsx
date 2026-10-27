import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONNECT_EMPTY_GUIDANCE, CONNECT_LABEL, CONNECT_PALETTE_ACTION, CONNECT_ROUTE } from '../src/core/connect-machine.js';
import { parseRoute } from '../src/core/route.js';
import { ICON_NAMES } from '../src/renderer/icons.js';
import { ConnectMenu } from '../src/renderer/components/ConnectMenu.js';

/**
 * THE WAY IN TO ANOTHER MACHINE (workstation plan row M1). One route, one name, one set of steps — shared by the title
 * bar's button, its menu, the Command Window and Settings, so none of them can drift into a second name for the same
 * thing. The menu is Genie 1's `HostsPanel` (v0.7.0-beta.342, renderer/pages/master.tsx): a row per machine, Open is a
 * click, and an empty list says what to do on the other machine.
 */

describe('the entry', () => {
    it('is called "Connect to another machine" and lands on Settings → Remote access', () => {
        expect(CONNECT_LABEL).toBe('Connect to another machine');
        expect(parseRoute(CONNECT_ROUTE)).toMatchObject({ surface: 'settings', section: 'remote' });
    });

    it('the Command Window offers it as an action under the same name and route', () => {
        expect(CONNECT_PALETTE_ACTION).toEqual({ id: 'connect-machine', label: CONNECT_LABEL, route: CONNECT_ROUTE });
    });

    it('the steps, exactly', () => {
        expect(CONNECT_EMPTY_GUIDANCE).toBe('Install Genie, sign in to Tynn, and turn on Remote access on the machine you want to reach.');
    });

    it('its icons are registered (an unregistered name renders an empty span)', () => {
        expect(ICON_NAMES).toEqual(expect.arrayContaining(['monitor', 'cloud']));
    });
});

describe('the menu', () => {
    const render = (props: Partial<Parameters<typeof ConnectMenu>[0]>) =>
        renderToStaticMarkup(<ConnectMenu workstations={null} onOpenWorkstation={() => {}} onOpenSurface={() => {}} {...props} />);

    it('a row per machine; Open on the ones Tynn says you may reach, the reason on the others', () => {
        const html = render({ workstations: { ok: true, workstations: [
            { id: 'ws_a', name: 'studio', active: true, connectable: true, local: true, source: 'owner' },
            { id: 'ws_b', name: 'old box', active: false, connectable: false, local: false, source: 'owner' },
        ] } });
        expect(html).toMatch(/data-tynn-workstation-row="ws_a"[^]*?data-action="open-workstation"/);
        const b = html.slice(html.indexOf('data-tynn-workstation-row="ws_b"'));
        expect(b.slice(0, b.indexOf('</li>'))).not.toContain('data-action="open-workstation"');
        expect(b.slice(0, b.indexOf('</li>'))).toContain('not active');
        expect(html).not.toContain(CONNECT_EMPTY_GUIDANCE);
    });

    it('empty: the steps', () => {
        expect(render({ workstations: { ok: true, workstations: [] } })).toContain(CONNECT_EMPTY_GUIDANCE);
    });

    it('Tynn could not be asked: its reason, and the steps', () => {
        const html = render({ workstations: { ok: false, reason: 'No relay is configured' } });
        expect(html).toContain('No relay is configured');
        expect(html).toContain(CONNECT_EMPTY_GUIDANCE);
    });

    it('not read yet: says it is looking, never the empty steps (absent is not zero)', () => {
        const html = render({ workstations: null });
        expect(html).not.toContain(CONNECT_EMPTY_GUIDANCE);
        expect(html).toContain('data-tynn-workstations="loading"');
    });

    it('always offers the full Remote access page — the host and PIN way lives there', () => {
        expect(render({ workstations: { ok: true, workstations: [] } })).toContain('data-action="open-connect-surface"');
    });
});
