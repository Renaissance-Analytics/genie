import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    CONNECT_EMPTY_GUIDANCE,
    CONNECT_LABEL,
    CONNECT_ROUTE,
    CONNECT_WORKSTATIONS_ACTION,
    OPEN_SHARE_LINK_ACTION,
    connectPaletteActions,
} from '../src/core/connect-machine.js';
import { parseRoute } from '../src/core/route.js';
import { ICON_NAMES } from '../src/renderer/icons.js';
import { ConnectMenu, ShareLinkForm, TynnWorkstationRows } from '../src/renderer/components/ConnectMenu.js';

/**
 * THE WAY IN TO ANOTHER MACHINE (genie#1278 row C1). One route, one name, one set of steps — shared by the title bar's
 * button, its menu, the Command Window and Settings, so none of them can drift into a second name for the same thing.
 * The menu is Genie 1's `HostsPanel` (v0.7.0-beta.342, renderer/pages/master.tsx:4879): a row per machine, Open is a
 * click, and an empty list says what to do on the other machine.
 */

describe('the entry', () => {
    it('is called "Connect to another machine" and its page is Settings → Remote access', () => {
        expect(CONNECT_LABEL).toBe('Connect to another machine');
        expect(parseRoute(CONNECT_ROUTE)).toMatchObject({ surface: 'settings', section: 'remote' });
    });

    it('the steps, exactly', () => {
        expect(CONNECT_EMPTY_GUIDANCE).toBe('Install Genie, sign in to Tynn, and turn on Remote access on the machine you want to reach.');
    });

    it('its icons are registered (an unregistered name renders an empty span)', () => {
        expect(ICON_NAMES).toEqual(expect.arrayContaining(['monitor', 'cloud', 'link', 'loader', 'check', 'refresh-cw']));
    });
});

describe('the Command Window offers the two ways in (the owner: paste a link, or find my workstations)', () => {
    it('a pilot: "Open a share link…" and "Connect to my workstations"', () => {
        expect(OPEN_SHARE_LINK_ACTION).toEqual({ id: 'open-share-link', label: 'Open a share link…' });
        expect(CONNECT_WORKSTATIONS_ACTION).toEqual({ id: 'connect-workstations', label: 'Connect to my workstations' });
        expect(connectPaletteActions('pilot')).toEqual([OPEN_SHARE_LINK_ACTION, CONNECT_WORKSTATIONS_ACTION]);
    });

    it('signed out (no Tynn role): both, so the person finds the way and is told to sign in', () => {
        expect(connectPaletteActions(null)).toEqual([OPEN_SHARE_LINK_ACTION, CONNECT_WORKSTATIONS_ACTION]);
    });

    it('a drone: neither — Tynn refuses a drone every connect-grant, so it offers nothing it would only be refused', () => {
        expect(connectPaletteActions('drone')).toEqual([]);
    });
});

describe('the menu', () => {
    const render = (props: Partial<Parameters<typeof ConnectMenu>[0]>) =>
        renderToStaticMarkup(<ConnectMenu workstations={null} onOpenWorkstation={() => {}} onOpenSurface={() => {}} onOpenLink={() => {}} {...props} />);

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

    it('always offers the full Remote access page, and a real button to paste a share link', () => {
        const html = render({ workstations: { ok: true, workstations: [] } });
        expect(html).toContain('data-action="open-connect-surface"');
        expect(html).toMatch(/<button[^>]*data-action="paste-share-link"/);
    });
});

describe('opening a workstation shows its progress, then success or the reason with Retry (the owner, 2026-10-27)', () => {
    const list = { ok: true as const, workstations: [{ id: 'ws_a', name: 'studio', active: true, connectable: true, local: true, source: 'owner' }] };
    const row = (opening: Parameters<typeof TynnWorkstationRows>[0]['opening']) =>
        renderToStaticMarkup(<TynnWorkstationRows list={list} onOpenWorkstation={() => {}} opening={opening} />);

    it('working: the current step, and Open is disabled so a second click does not open a second window', () => {
        const html = row({ ws_a: { kind: 'working', step: 'Opening its window…' } });
        expect(html).toContain('data-connect-step=""');
        expect(html).toContain('Opening its window…');
        expect(html).toMatch(/<button[^>]*data-action="open-workstation"[^>]*disabled=""/);
    });

    it('done: says so', () => {
        const html = row({ ws_a: { kind: 'done', note: 'Opened in its own window' } });
        expect(html).toContain('data-connect-done=""');
        expect(html).toContain('Opened in its own window');
    });

    it('failed: the reason, and Retry', () => {
        const html = row({ ws_a: { kind: 'failed', reason: 'Tynn did not give this machine a way in' } });
        expect(html).toContain('Tynn did not give this machine a way in');
        expect(html).toMatch(/<button[^>]*data-action="retry-workstation"/);
    });

    it('CONTROL: idle has an enabled Open and no step, no Retry', () => {
        const html = row({});
        expect(html).toMatch(/<button[^>]*data-action="open-workstation"(?![^>]*disabled)[^>]*>/);
        expect(html).not.toContain('data-connect-step');
        expect(html).not.toContain('retry-workstation');
    });
});

describe('the share-link form: paste, Open, progress, then success or the reason with Retry', () => {
    const form = (state: Parameters<typeof ShareLinkForm>[0]['state'], value = 'https://tynn.ai/invites/accept/tok') =>
        renderToStaticMarkup(<ShareLinkForm value={value} state={state} onChange={() => {}} onOpen={() => {}} />);

    it('idle: a field to paste into and an enabled Open button', () => {
        const html = form({ kind: 'idle' });
        expect(html).toMatch(/<input[^>]*data-share-link-input=""/);
        expect(html).toMatch(/<button[^>]*data-action="open-share-link"(?![^>]*disabled)[^>]*>/);
    });

    it('idle with nothing pasted: Open is disabled', () => {
        expect(form({ kind: 'idle' }, '')).toMatch(/<button[^>]*data-action="open-share-link"[^>]*disabled=""/);
    });

    it('working: the step, and Open disabled', () => {
        const html = form({ kind: 'working', step: 'Checking the link…' });
        expect(html).toContain('Checking the link…');
        expect(html).toMatch(/<button[^>]*data-action="open-share-link"[^>]*disabled=""/);
    });

    it('done: what happened', () => {
        expect(form({ kind: 'done', note: 'Opened the invite in your browser' })).toContain('Opened the invite in your browser');
    });

    it('failed: the reason, and Retry', () => {
        const html = form({ kind: 'failed', reason: 'That is a Tynn link, but not a share link.' });
        expect(html).toContain('That is a Tynn link, but not a share link.');
        expect(html).toMatch(/<button[^>]*data-action="retry-share-link"/);
    });
});
