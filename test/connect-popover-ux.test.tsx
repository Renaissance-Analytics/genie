import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectMenu, TynnWorkstationRows } from '../src/renderer/components/ConnectMenu.js';
import { ConnectRemote } from '../src/renderer/components/FeatureSurfaces.js';

/**
 * "YOUR WORKSTATIONS" READS AT A GLANCE (the owner, 2026-10-28, on beta.50's popover: "the workstation connection UI is
 * ugly"): names were cut ("Foundati…"), every row repeated a full "Make drone" button that wrapped onto two lines, the
 * pilot role was a lone paper-plane glyph nobody could read, and each machine sat in its own boxed card.
 *
 * Genie 1 (v0.7.0-beta.342, renderer/pages/master.tsx HostsPanel :4879-5137): a compact list, one line per machine —
 * its state, its name in bold, a small Open — a ⟳ rescan in the corner, and no other per-row buttons but Forget.
 * Changing a machine's role is not connecting to it: the switch lives in Settings → Remote access (W6's own surface).
 */

const LIST = { ok: true as const, workstations: [
    { id: 'ws_found', name: 'Foundation-Workstation', active: true, connectable: true, local: true, source: 'owner', role: 'drone' as const },
    { id: 'ws_aion', name: 'Aionima', active: true, connectable: true, local: true, source: 'owner', role: 'pilot' as const },
] };
const row = (html: string, id: string) => { const at = html.slice(html.indexOf(`data-tynn-workstation-row="${id}"`)); return at.slice(0, at.indexOf('</li>')); };
const setRole = async () => ({ ok: true as const, role: 'drone' as const });

describe('the popover', () => {
    const html = renderToStaticMarkup(<ConnectMenu workstations={LIST} onOpenWorkstation={() => {}} onOpenSurface={() => {}} onRefresh={() => {}} {...({ onSetRole: setRole } as object)} />);

    it('names are shown in full: never cut with an ellipsis', () => {
        expect(row(html, 'ws_found')).toContain('Foundation-Workstation');
        expect(row(html, 'ws_found')).not.toMatch(/class="[^"]*\btruncate\b[^"]*"[^>]*>Foundation-Workstation/);
    });

    it('no role switch in the popover, even for a pilot', () => {
        expect(html).not.toContain('data-action="change-role"');
        expect(html).not.toContain('Make drone');
    });

    it('the role is a badge with its word, not a lone glyph', () => {
        expect(row(html, 'ws_aion')).toMatch(/data-workstation-role="pilot"[^>]*>(?:<[^>]+>)*[^<]*(?:<[^>]+>)*Pilot</);
        expect(row(html, 'ws_found')).toMatch(/data-workstation-role="drone"[^>]*>(?:<[^>]+>)*[^<]*(?:<[^>]+>)*Drone</);
    });

    it('rows are a list, not boxed cards', () => {
        expect(row(html, 'ws_found')).not.toMatch(/data-tynn-workstation-row="ws_found"[^>]*class="[^"]*\bborder\b/);
    });

    it('Open is a real button on every machine you may reach', () => {
        expect(row(html, 'ws_found')).toMatch(/<button[^>]*data-action="open-workstation"/);
    });

    it('ask Tynn again from the menu itself (Genie 1’s ⟳): a real button', () => {
        expect(html).toMatch(/<button[^>]*data-action="refresh-workstations"/);
    });
});

describe('the role switch stays reachable: Settings → Remote access', () => {
    it('a pilot gets it there, on one line', () => {
        const html = renderToStaticMarkup(<ConnectRemote state={null} remembered={[]} onConnect={() => {}} onDisconnect={() => {}} tynnWorkstations={LIST} onOpenWorkstation={() => {}} onSetRole={setRole} />);
        expect(row(html, 'ws_found')).toMatch(/<button[^>]*data-action="change-role"[^>]*class="[^"]*whitespace-nowrap/);
    });

    it('CONTROL: TynnWorkstationRows with onSetRole still offers it (what Settings renders)', () => {
        const html = renderToStaticMarkup(<TynnWorkstationRows list={LIST} onOpenWorkstation={() => {}} onSetRole={setRole} />);
        expect(html).toContain('data-action="change-role"');
    });
});

describe('wired: the title bar and ⌘K hand the popover no role switch', () => {
    const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const shell = strip(readFileSync(new URL('../src/renderer/Shell.tsx', import.meta.url), 'utf8'));
    const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));

    it('Shell’s title-bar connect object carries no onSetRole', () => {
        const connect = /connect=\{remote \|\| !remoteConnect[^\n]*/.exec(shell)?.[0] ?? '';
        expect(connect).toContain('onOpenWorkstation');
        expect(connect).not.toContain('onSetRole');
    });

    it('the ⌘K dialog is given no onSetRole', () => {
        const dialog = /<ConnectDialog([^]*?)\/>/.exec(app)?.[1] ?? '';
        expect(dialog).toContain('onOpenWorkstation');
        expect(dialog).not.toContain('onSetRole');
    });
});
