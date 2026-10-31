// @vitest-environment happy-dom
/**
 * THE CONFIRM AND THE EXPIRY MARK, AS A PERSON SEES THEM (the owner, 2026-10-31, q_8c07b142).
 *
 * - "Pair this device?" on the desktop names the device, has a real Allow and a real Deny, shows progress once pressed,
 *   says what happened (never silent), offers Retry if the answer did not land, and NEVER takes the keyboard from
 *   whatever the person is typing in (Genie 1's question window rule: shown without focus).
 * - The phone, while it waits, says it is waiting for Allow on the host.
 * - A yellow ! on the Settings row, its tooltip naming the device and the date; the same mark on the device's row in
 *   Settings → Remote access, with Re-pair.
 *
 * Interaction and focus are claims about a live DOM, so this file renders in happy-dom (docs/decisions.md D4).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, deviceExpiryText } from '../src/core/device-expiry.js';
import { deviceLabelFromUserAgent } from '../src/core/mobile.js';
import type { PairRequest } from '../src/core/pair-confirm.js';
import { inMemoryPair } from '../src/core/remote-protocol.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import { MobilePair } from '../src/renderer/components/MobileShell.js';
import { PairPrompt } from '../src/renderer/components/PairPrompt.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import type { RemoteSection } from '../src/renderer/features.js';

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const request = (over: Partial<PairRequest> = {}): PairRequest => ({ id: 'pair_1', label: 'Pixel 7', from: '100.101.7.9', host: 'alphar', replaces: null, raisedAt: NOW, expiresAt: NOW + 120_000, ...over });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

describe('PairPrompt — "Pair this device?" on the desktop', () => {
    it('names the device, where it is connecting from, and this machine; offers a real Allow and a real Deny; says what pairing grants', () => {
        act(() => root.render(<PairPrompt requests={[request()]} now={NOW} onAnswer={async () => {}} />));
        const prompt = host.querySelector('[data-pair-prompt]')!;
        expect(prompt).not.toBeNull();
        expect(prompt.getAttribute('role')).toBe('alertdialog');
        expect(prompt.textContent).toContain('Pair this device?');
        expect(prompt.textContent).toContain('Pixel 7');
        expect(prompt.textContent).toContain('100.101.7.9');
        expect(prompt.textContent).toContain('alphar');
        expect(prompt.textContent).toContain('Allow only if this is your device');
        expect(button('Allow')?.type).toBe('button');
        expect(button('Deny')?.type).toBe('button');
        expect(host.querySelector('[data-pair-countdown]')!.textContent).toBe('2:00 left');
    });

    it('NEVER takes focus: the person typing elsewhere keeps the caret when the prompt appears', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        expect(document.activeElement).toBe(input);
        act(() => root.render(<PairPrompt requests={[request()]} now={NOW} onAnswer={async () => {}} />));
        expect(document.activeElement).toBe(input);
        expect(host.querySelector('[autofocus]')).toBeNull();
    });

    it('Allow: answers allow for THAT request, shows progress with both buttons disabled, then says the device is paired', async () => {
        let resolve: () => void = () => {};
        const onAnswer = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
        act(() => root.render(<PairPrompt requests={[request()]} now={NOW} onAnswer={onAnswer} />));
        act(() => button('Allow')!.click());
        expect(onAnswer).toHaveBeenCalledWith('pair_1', true);
        expect(button('Allowing…')?.disabled).toBe(true);
        expect(button('Deny')?.disabled).toBe(true);
        await act(async () => { resolve(); });
        // The request is gone from the host's snapshot; the outcome stays on screen, said in words.
        act(() => root.render(<PairPrompt requests={[]} now={NOW} onAnswer={onAnswer} />));
        expect(host.querySelector('[data-pair-outcome="allowed"]')!.textContent).toBe('Pixel 7 is paired with alphar.');
    });

    it('Deny: answers deny, shows progress, then says nothing was paired', async () => {
        const onAnswer = vi.fn(async () => {});
        act(() => root.render(<PairPrompt requests={[request()]} now={NOW} onAnswer={onAnswer} />));
        act(() => button('Deny')!.click());
        expect(onAnswer).toHaveBeenCalledWith('pair_1', false);
        await flush();
        act(() => root.render(<PairPrompt requests={[]} now={NOW} onAnswer={onAnswer} />));
        expect(host.querySelector('[data-pair-outcome="denied"]')!.textContent).toBe('Denied: Pixel 7 was not paired.');
    });

    it('an answer that did not land says so, with Retry — never a silent no-op', async () => {
        const onAnswer = vi.fn().mockRejectedValueOnce(new Error('Genie is not ready')).mockResolvedValueOnce(undefined);
        act(() => root.render(<PairPrompt requests={[request()]} now={NOW} onAnswer={onAnswer} />));
        act(() => button('Allow')!.click());
        await flush();
        expect(host.querySelector('[data-pair-failed]')!.textContent).toContain('Genie is not ready');
        act(() => button('Retry')!.click());
        expect(onAnswer).toHaveBeenLastCalledWith('pair_1', true);
    });

    it('a request that lapsed while up says it timed out instead of vanishing', () => {
        act(() => root.render(<PairPrompt requests={[request()]} now={NOW} onAnswer={async () => {}} />));
        act(() => root.render(<PairPrompt requests={[]} now={NOW + 120_000} onAnswer={async () => {}} />));
        expect(host.querySelector('[data-pair-outcome="expired"]')!.textContent).toBe('Nobody answered in time: Pixel 7 was not paired.');
    });

    it('a Re-pair names the device it replaces', () => {
        act(() => root.render(<PairPrompt requests={[request({ replaces: { id: 'dev_old', label: 'Pixel 7 (old)' } })]} now={NOW} onAnswer={async () => {}} />));
        expect(host.querySelector('[data-pair-prompt]')!.textContent).toContain('It replaces Pixel 7 (old)');
    });
});

describe('the phone while it waits', () => {
    it('says it is waiting for Allow on the host, with the time left, and cannot be sent twice', () => {
        const html = renderToStaticMarkup(<MobilePair host="alphar:7421" refusal={null} connecting={true} waiting={{ expiresAt: NOW + 90_000 }} now={NOW} onConnect={() => {}} />);
        expect(html).toMatch(/data-mobile-waiting/);
        expect(html).toContain('Press Allow on alphar:7421 to finish pairing');
        expect(html).toContain('1:30 left');
        expect(html).toMatch(/<button[^>]*disabled[^>]*>Waiting for Allow…<\/button>/);
    });

    it('a denial is shown as the host said it', () => {
        const html = renderToStaticMarkup(<MobilePair host="alphar:7421" refusal="Pairing was denied on alphar. Ask for a new PIN to try again." connecting={false} onConnect={() => {}} />);
        expect(html).toContain('Pairing was denied on alphar. Ask for a new PIN to try again.');
    });

    it('the client hears the host’s "waiting for Allow" and clears it on the answer', async () => {
        const pair = inMemoryPair();
        const client = connectRemote(pair.client, { kind: 'pin', code: '482913', label: 'Pixel 7' }, 'Pixel 7', { profile: 'mobile' });
        pair.server.send(JSON.stringify({ kind: 'pairing', host: 'alphar', expiresAt: NOW + 120_000 }));
        await flush();
        expect(client.state().pairing).toEqual({ expiresAt: NOW + 120_000 });
        pair.server.send(JSON.stringify({ kind: 'refused', reason: 'Pairing was denied on alphar. Ask for a new PIN to try again.' }));
        await expect(client.ready).resolves.toEqual({ ok: false, reason: 'Pairing was denied on alphar. Ask for a new PIN to try again.' });
        expect(client.state().pairing).toBeNull();
    });

    it('the prompt names the phone by its model, not "phone"', () => {
        expect(deviceLabelFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36')).toBe('Pixel 7');
        expect(deviceLabelFromUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36')).toBe('Android phone');
        expect(deviceLabelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('iPhone');
        expect(deviceLabelFromUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('iPad');
        expect(deviceLabelFromUserAgent('')).toBe('phone');
    });
});

describe('the yellow ! on the Settings row', () => {
    const label = 'The pairing for Pixel 7 expires on Nov 14, 2026. Connect from that device to renew it, or Re-pair it in Settings → Remote access.';
    const rail = (over: Partial<Parameters<typeof Sidebar>[0]> = {}) =>
        renderToStaticMarkup(<Sidebar route="genie://dashboard" available={['dashboard', 'settings']} workspaces={[]} deckCount={0} onNavigate={() => {}} railStorage={null} {...over} />);

    it('shows a yellow ! on the Settings row whose tooltip names the device and the date', () => {
        act(() => root.render(<Sidebar route="genie://dashboard" available={['dashboard', 'settings']} workspaces={[]} deckCount={0} onNavigate={() => {}} railStorage={null} settingsAlert={{ label }} />));
        const settings = host.querySelector('[data-nav="genie://settings"]')!;
        const mark = settings.querySelector('[data-settings-alert]')!;
        expect(mark.textContent).toBe('!');
        expect(mark.getAttribute('title')).toBe(label);
        expect(mark.getAttribute('aria-label')).toBe(label);
        expect(mark.className).toContain('var(--warning)');
    });

    it('no alert, no mark', () => {
        expect(rail()).not.toMatch(/data-settings-alert/);
        expect(rail({ settingsAlert: null })).not.toMatch(/data-settings-alert/);
    });

    it('the collapsed rail shows it too', () => {
        const store = { getItem: () => '1', setItem: () => {} };
        const html = rail({ settingsAlert: { label }, railStorage: store });
        expect(html).toMatch(/data-rail="collapsed"/);
        expect(html).toMatch(/data-settings-alert/);
    });
});

describe('the device’s row in Settings → Remote access', () => {
    const remote = (devices: RemoteSection['devices']): RemoteSection => ({
        host: 'alphar', url: 'wss://alphar:7421/genie', unavailable: null, locked: false, pin: null, devices, shares: [], connections: [], servedLink: null, enabled: true, firewall: false, pairRequests: [],
    });
    const soon = { id: 'dev_soon', label: 'Pixel 7', pairedAt: new Date(NOW - 80 * DAY_MS).toISOString(), lastSeenAt: new Date(NOW - 80 * DAY_MS).toISOString(), expiresAt: new Date(NOW + 10 * DAY_MS).toISOString() };
    const fresh = { id: 'dev_fresh', label: 'iPad', pairedAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 90 * DAY_MS).toISOString() };

    it('a device close to its end carries the same yellow ! and tooltip, and offers Re-pair; one far from it does not', () => {
        const onAction = vi.fn();
        act(() => root.render(<RemoteAccess remote={remote([soon, fresh])} workspaces={[]} onAction={onAction} now={NOW} />));
        const row = host.querySelector('[data-device="dev_soon"]')!;
        const mark = row.querySelector('[data-device-expiry-alert]')!;
        expect(mark.textContent).toBe('!');
        expect(mark.getAttribute('title')).toBe(deviceExpiryText('Pixel 7', soon.expiresAt));
        const repair = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Re-pair')!;
        act(() => repair.click());
        expect(onAction).toHaveBeenCalledWith({ kind: 'remote.issuePin', replaces: 'dev_soon' });

        const other = host.querySelector('[data-device="dev_fresh"]')!;
        expect(other.querySelector('[data-device-expiry-alert]')).toBeNull();
        expect([...other.querySelectorAll('button')].some((b) => b.textContent === 'Re-pair')).toBe(false);
    });
});
