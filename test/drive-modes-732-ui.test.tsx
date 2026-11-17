// @vitest-environment happy-dom
/**
 * VIEW ONLY OR FULL CONTROL, AS BOTH PEOPLE SEE IT (Tynn #732). On the machine being reached, the #726 banner names the
 * mode and holds the switch (a react-fancy MultiSwitch per person, in the bar's fixed height: no layout jump). On the
 * other window, the title bar's badge says "view only" and stops offering Take control; Settings says the same. The
 * other window learns the mode from the host (its welcome, then each baton event), never decides it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BATON_EVENT, inMemoryPair } from '../src/core/remote-protocol.js';
import { ConnectedHereBanner } from '../src/renderer/components/ConnectedHereBanner.js';
import { ConnectRemote } from '../src/renderer/components/FeatureSurfaces.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import type { FeatureAction, RemoteSection } from '../src/renderer/features.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let el: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); el.remove(); document.body.innerHTML = ''; });
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

type Conn = { id: string; label: string; isOwner: boolean; workspaceId: string | null; driving: boolean; mode: 'view' | 'control' };
const conn = (id: string, label: string, mode: 'view' | 'control', driving = false): Conn => ({ id, label, isOwner: false, workspaceId: 'tynn', driving, mode });
const section = (connections: Conn[]): RemoteSection => ({
    host: 'client-box', url: null, unavailable: null, locked: false, pin: null, devices: [], pairRequests: [], connections,
    enabled: true, firewall: false, firewallRule: null, firewallOutcome: null, tailscale: null, tailscaleOutcome: null, tynnWorkstation: null,
} as unknown as RemoteSection);
const radios = (html: string, label: string) => {
    const at = html.indexOf(`data-connected-mode="${label}"`);
    expect(at).toBeGreaterThan(-1);
    const after = html.indexOf('data-connected-mode="', at + 1);
    const group = html.slice(at, after === -1 ? html.length : after);
    expect(group).toMatch(/role="radiogroup"/);
    return [...group.matchAll(/role="radio"[^>]*aria-checked="(true|false)"[^>]*>([\s\S]*?)<\//g)].map((m) => [m[2]!.replace(/<[^>]+>/g, ''), m[1]]);
};

describe('the banner on the machine being reached (Tynn #732)', () => {
    it('says the mode and holds the switch: View checked for a person on view only', () => {
        const html = renderToStaticMarkup(<ConnectedHereBanner remote={section([conn('c1', 'wren', 'view')])} onAction={() => {}} onNavigate={() => {}} />);
        expect(html).toContain('wren is connected · view only');
        expect(radios(html, 'wren')).toEqual([['View', 'true'], ['Control', 'false']]);
    });

    it('choosing Control asks this machine to give that person full control', async () => {
        const acted: FeatureAction[] = [];
        act(() => root.render(<ConnectedHereBanner remote={section([conn('c1', 'wren', 'view')])} onAction={(a) => { acted.push(a); }} onNavigate={() => {}} />));
        const control = [...el.querySelectorAll('[data-connected-mode="wren"] [role="radio"]')].find((r) => r.textContent === 'Control') as HTMLElement;
        await act(async () => { control.click(); });
        expect(acted).toEqual([{ kind: 'remote.setMode', label: 'wren', mode: 'control' }]);
    });

    it('two people: a switch each, named', () => {
        const html = renderToStaticMarkup(<ConnectedHereBanner remote={section([conn('c1', 'wren', 'view'), conn('c2', 'Pat', 'control', true)])} onAction={() => {}} onNavigate={() => {}} />);
        expect(radios(html, 'wren')).toEqual([['View', 'true'], ['Control', 'false']]);
        expect(radios(html, 'Pat')).toEqual([['View', 'false'], ['Control', 'true']]);
    });
});

describe('the other window (Tynn #732)', () => {
    const badge = (viewOnly: boolean) => renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }}
        remote={{ host: 'studio', driver: null, driving: false, locked: false, viewOnly, onTakeControl: () => {} }} onNavigate={() => {}} onOpenPalette={() => {}} />);

    it('its badge says view only and offers no Take control', () => {
        const html = badge(true);
        expect(html).toMatch(/data-remote-badge[\s\S]*view only/);
        expect(html).not.toContain('data-action="take-control"');
    });

    it('CONTROL: in full control the badge offers Take control as before', () => {
        expect(badge(false)).toContain('data-action="take-control"');
    });

    it('Settings says view only', () => {
        const html = renderToStaticMarkup(<ConnectRemote state={{ connected: true, host: 'studio', isOwner: false, workspaceId: 'tynn', driver: null, driving: false, locked: false, lastRefusal: null, token: null, viewOnly: true }} remembered={[]} onConnect={() => {}} onDisconnect={() => {}} />);
        expect(html).toContain('Driving studio — view only');
    });

    it('learns it from the host: a view-only welcome takes no baton; each baton event says the mode, its absence full control', async () => {
        const pair = inMemoryPair();
        const sent: string[] = [];
        pair.server.onMessage((text) => { sent.push((JSON.parse(text) as { method?: string }).method ?? ''); });
        const remote = connectRemote(pair.client, { kind: 'relay' }, 'wren', { drive: true });
        pair.server.send(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'studio', isOwner: false, workspaceId: 'tynn', viewOnly: true }));
        await settle();
        expect(remote.state().viewOnly).toBe(true);
        expect(sent).not.toContain('baton.take');
        pair.server.send(JSON.stringify({ kind: 'event', channel: BATON_EVENT, payload: { driver: null, mine: false, locked: false, by: null } }));
        await settle();
        expect(remote.state().viewOnly).toBe(false);
        pair.server.send(JSON.stringify({ kind: 'event', channel: BATON_EVENT, payload: { driver: null, mine: false, locked: false, by: null, viewOnly: true } }));
        await settle();
        expect(remote.state().viewOnly).toBe(true);
        remote.close();
    });

    it('CONTROL: a full-control welcome takes the baton, as before', async () => {
        const pair = inMemoryPair();
        const sent: string[] = [];
        pair.server.onMessage((text) => { sent.push((JSON.parse(text) as { method?: string }).method ?? ''); });
        const remote = connectRemote(pair.client, { kind: 'relay' }, 'wren', { drive: true });
        pair.server.send(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'studio', isOwner: false, workspaceId: 'tynn' }));
        await settle();
        expect(sent).toContain('baton.take');
        remote.close();
    });

    it('wiring: the window hands its badge the mode it was told', () => {
        const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
        expect(app).toMatch(/viewOnly: remote\.state\.viewOnly === true/);
        const shell = readFileSync(join(__dirname, '../src/renderer/Shell.tsx'), 'utf8');
        expect(shell).toMatch(/viewOnly/);
    });
});
