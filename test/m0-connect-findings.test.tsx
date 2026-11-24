import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { mergeWorkstationRead } from '../src/core/connect-machine.js';
import { accountKeyOf, remoteWindowAction, windowsLeftByAccountChange } from '../src/core/remote-window-policy.js';
import { connectableWorkstations, mintConnectGrant } from '../src/main/tynn-network.js';
import { ConnectMenu } from '../src/renderer/components/ConnectMenu.js';

/**
 * THE THREE M0 FINDINGS (genie#1278, two-VM proof 2026-10-28; the owner chose "fix first"):
 *  1. the Connect list was read at sign-in only — a share accepted afterwards did not appear until a reload;
 *  2. after an account switch, Open brought forward the OLD account's dropped window instead of connecting;
 *  3. a demoted machine (still believing it was a pilot) was told to "sign in to Tynn" when Tynn refused it.
 */

const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const main = strip(readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
const preload = strip(readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8'));
const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
const titleBar = strip(readFileSync(new URL('../src/renderer/components/TitleBar.tsx', import.meta.url), 'utf8'));
const menu = strip(readFileSync(new URL('../src/renderer/components/ConnectMenu.tsx', import.meta.url), 'utf8'));
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const row = { id: 'ws_b', name: 'genie-test-win', active: true, connectable: true, local: true, source: 'share' };

describe('1. the list is read again whenever it is opened', () => {
    it('a fresh answer replaces the list', () => {
        const prev = { ok: true as const, workstations: [] };
        expect(mergeWorkstationRead(prev, { ok: true, workstations: [row] })).toEqual({ list: { ok: true, workstations: [row] }, problem: null });
    });

    it('a failed refresh keeps the last list on screen, and says why', () => {
        const prev = { ok: true as const, workstations: [row] };
        expect(mergeWorkstationRead(prev, { ok: false, reason: 'Tynn could not be reached (ECONNRESET)' })).toEqual({ list: prev, problem: 'Tynn could not be reached (ECONNRESET)' });
    });

    it('a failure with no list yet is the list (its reason and the steps), not a hidden problem', () => {
        const failed = { ok: false as const, reason: 'sign in to Tynn to see your workstations' };
        expect(mergeWorkstationRead(null, failed)).toEqual({ list: failed, problem: null });
    });

    const render = (props: Partial<Parameters<typeof ConnectMenu>[0]>) =>
        renderToStaticMarkup(<ConnectMenu workstations={{ ok: true, workstations: [row] }} onOpenWorkstation={() => {}} onOpenSurface={() => {}} {...props} />);

    it('refreshing: the last list stays, with a step saying Tynn is being asked', () => {
        const html = render({ refresh: { kind: 'working', step: 'Asking Tynn…' }, onRefresh: () => {} });
        expect(html).toContain('data-tynn-workstation-row="ws_b"');
        expect(html).toMatch(/data-tynn-refresh="working"[^]*Asking Tynn…/);
    });

    it('a failed refresh: the reason and Retry, with the last list still there', () => {
        const html = render({ refresh: { kind: 'failed', reason: 'Tynn could not be reached' }, onRefresh: () => {} });
        expect(html).toContain('data-tynn-workstation-row="ws_b"');
        expect(html).toContain('Tynn could not be reached');
        expect(html).toMatch(/<button[^>]*data-action="retry-workstations"/);
    });

    it('CONTROL: idle shows neither step nor Retry', () => {
        const html = render({ refresh: { kind: 'idle' }, onRefresh: () => {} });
        expect(html).not.toContain('data-tynn-refresh=');
        expect(html).not.toContain('retry-workstations');
    });

    it('wired: the title bar re-reads when its menu opens; the ⌘K window re-reads when it opens; the app passes the reader', () => {
        expect(titleBar).toMatch(/onOpenChange=\{\(open\) => \{ setConnectOpen\(open\); if \(open\) connect\.onRefresh\?\.\(\); \}\}/);
        expect(menu).toMatch(/useEffect\(\(\) => \{ if \(mode === 'workstations'\) onRefresh\?\.\(\); \}, \[mode\]\)/);
        expect(app).toContain('onRefresh: remote.reloadTynnWorkstations');
        expect(app).toContain('refresh: remote.tynnRefresh');
    });
});

describe('2. Open never brings forward another account’s window, or a dropped one', () => {
    // Whether a relay window's link is up is the window's own to know since 2f-2 (Tynn #941): main brings it up and asks it to
    // reconnect, and a window still connected does nothing with the ask (split-2f2-relay-frames.test.ts pins that guard).
    const base = { exists: true, relay: true, openedBy: 'tynn.ai#62', account: 'tynn.ai#62' };

    it('no window: open one', () => {
        expect(remoteWindowAction({ ...base, exists: false })).toBe('open');
    });
    it('the same account: bring it forward and ask it to reconnect, under this account (connected, it stays as it is)', () => {
        expect(remoteWindowAction(base)).toBe('reconnect');
    });
    it('opened under another account (or signed out since): replace it with a fresh connection', () => {
        expect(remoteWindowAction({ ...base, account: 'tynn.ai#63' })).toBe('replace');
        expect(remoteWindowAction({ ...base, account: null })).toBe('replace');
    });
    it('a tailnet window (not a Tynn grant) is not bound to the Tynn account', () => {
        expect(remoteWindowAction({ ...base, relay: false, account: 'tynn.ai#63' })).toBe('focus');
    });

    it('an account change closes exactly the relay windows opened under another account', () => {
        const windows = [
            { key: 'relay:ws_b', relay: true, openedBy: 'tynn.ai#62' },
            { key: 'relay:ws_c', relay: true, openedBy: 'tynn.ai#63' },
            { key: 'wss://studio:7421/genie', relay: false, openedBy: 'tynn.ai#62' },
        ];
        expect(windowsLeftByAccountChange(windows, 'tynn.ai#63')).toEqual(['relay:ws_b']);
        expect(windowsLeftByAccountChange(windows, null)).toEqual(['relay:ws_b', 'relay:ws_c']);
    });

    it('the account is the Tynn host and the user, never only one of them', () => {
        expect(accountKeyOf({ signedIn: true, host: 'https://tynn.ai', user: { name: 'M0 Owner', email: 'm0-owner@example.com' } })).toBe('https://tynn.ai#m0-owner@example.com');
        expect(accountKeyOf({ signedIn: false })).toBeNull();
    });

    it('wired: main decides with the policy, closes on an account change, and asks a dropped window to reconnect', () => {
        const open = /function openRemoteWindow\([^]*?\n\}/.exec(main)?.[0] ?? '';
        expect(open).toContain('remoteWindowAction(');
        expect(open).toContain("'genie:remote-reconnect'");
        // Heard from genie-host's summary since 2g-3a (Tynn #954): the account it is signed in to changed.
        expect(main).toMatch(/if \(summary\.tynnAccountKey !== hostSummaryNow\.tynnAccountKey\) \{ hostSummaryNow = summary; closeRelayWindowsOfOtherAccounts\(\); \}/);
        const close = /function closeRelayWindowsOfOtherAccounts\(\)[^]*?\n\}/.exec(main)?.[0] ?? '';
        expect(close).toContain('windowsLeftByAccountChange(');
        expect(close).toContain('.destroy()');
        expect(preload).toMatch(/onReconnectAsked: \(listener\) =>/);
        expect(app).toMatch(/onReconnectAsked\?\.\(/);
    });
});

describe('3. Tynn’s refusal is marked as Tynn’s, and said in its own words', () => {
    it('Tynn’s 404 on a grant or the list is marked as Tynn’s refusal', async () => {
        const grant = await mintConnectGrant(async () => json(404, {}), 'ws_a', { kty: 'OKP', crv: 'Ed25519', x: 'x' } as never);
        expect(grant).toMatchObject({ ok: false, refusedByTynn: true });
        const list = await connectableWorkstations(async () => json(404, {}), new Set());
        expect(list).toMatchObject({ ok: false, refusedByTynn: true });
    });

    it('CONTROL: a 500 is not Tynn refusing this caller', async () => {
        const grant = await mintConnectGrant(async () => json(500, { message: 'boom' }), 'ws_a', { kty: 'OKP', crv: 'Ed25519', x: 'x' } as never);
        expect(grant).not.toHaveProperty('refusedByTynn');
    });

    it('Tynn’s refusal is said in Tynn’s words: the role is not read again to re-word it (Tynn #423: a drone connects out, so "drone" says nothing about why Tynn refused)', () => {
        // "Your workstations" is genie-host's answer for every client (Tynn #898 steps 2d-3b and 2d-4b2).
        const ops = strip(readFileSync(new URL('../src/main/host-owner-ops.ts', import.meta.url), 'utf8'));
        const list = /workstations: async \(\) => \{([^]*?)\n {12}\},/.exec(ops)?.[1] ?? '';
        expect(list).toContain('return connectableWorkstations(');
        expect(list).not.toMatch(/rereadRole|wordTynnRefusal/);
        // The grant: genie-host's device protocol answers Tynn's own reason (connect-out-any-role-423.test.ts).
        const host = strip(readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8'));
        expect(host).not.toContain('wordTynnRefusal');
    });
});
