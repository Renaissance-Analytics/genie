// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import { pinTimeLeft } from '../src/renderer/components/PairPin.js';
import type { FeatureAction, RemoteSection } from '../src/renderer/features.js';

/**
 * THE PIN'S CLOCK ON THE DESKTOP (Tynn #751). The PIN showed "type this on the device within two minutes" and nothing
 * else, for as long as it was on screen and after; when it lapsed the person learnt it from the phone ("no PIN is
 * active"). Now the time left shows beside the code; when it lapses, or five wrong tries cancel it, the QR's place says
 * so with New PIN, in the same footprint, so nothing below it moves.
 */

const T0 = 1_800_000_000_000;
const base: RemoteSection = {
    host: 'alphar', url: 'ws://alphar.tailnet.invalid:7421/genie', unavailable: null, locked: false,
    pin: { code: '482913', expiresAt: T0 + 120_000 }, devices: [], connections: [], enabled: true, firewall: false,
};
const html = (remote: RemoteSection, now: number) => renderToStaticMarkup(<RemoteAccess remote={remote} workspaces={[]} onAction={() => {}} now={now} />);
const ended = (reason: 'expired' | 'cancelled', replaces?: string): RemoteSection => ({ ...base, pin: null, pinEnded: { reason, at: T0 + 120_001, ...(replaces ? { replaces } : {}) } });

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
});
function mount(remote: RemoteSection, now: number, onAction: (a: FeatureAction) => void = () => {}) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<RemoteAccess remote={remote} workspaces={[]} onAction={onAction} now={now} />));
    return host;
}

describe('the time left', () => {
    it('pinTimeLeft reads minutes and seconds, and never goes below 0:00', () => {
        expect(pinTimeLeft(T0 + 120_000, T0)).toBe('2:00');
        expect(pinTimeLeft(T0 + 120_000, T0 + 18_000)).toBe('1:42');
        expect(pinTimeLeft(T0 + 120_000, T0 + 114_500)).toBe('0:06');
        expect(pinTimeLeft(T0 + 120_000, T0 + 200_000)).toBe('0:00');
    });

    it('an active PIN shows its time left beside the code, in a slot of fixed width (no jump as the digits change)', () => {
        const out = html(base, T0 + 18_000);
        expect(out).toContain('data-pin="482913"');
        expect(out).toMatch(/data-pin-left="[^"]*"[^>]*class="[^"]*tabular-nums[^"]*"|class="[^"]*tabular-nums[^"]*"[^>]*data-pin-left/);
        expect(out).toMatch(/1:42/);
    });

    it('it ticks: a second later the time left is a second less', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0 + 18_000);
        const el = mount(base, T0 + 18_000);
        expect(el.querySelector('[data-pin-left]')?.textContent).toContain('1:42');
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(el.querySelector('[data-pin-left]')?.textContent).toContain('1:41');
    });
});

describe('when it lapses', () => {
    it('ended as expired: no code and no QR; "PIN expired" and New PIN in the QR’s place', () => {
        const out = html(ended('expired'), T0 + 121_000);
        expect(out).not.toContain('data-pin="');
        expect(out).not.toContain('data-pairing-qr');
        expect(out).toContain('data-pin-ended="expired"');
        expect(out).toMatch(/PIN expired/);
        expect(out).toContain('data-action="new-pin"');
    });

    it('cancelled by five wrong tries says that, not "expired"', () => {
        const out = html(ended('cancelled'), T0 + 121_000);
        expect(out).toContain('data-pin-ended="cancelled"');
        expect(out).toMatch(/Too many wrong tries/);
        expect(out).not.toMatch(/PIN expired/);
    });

    it('this window’s clock passing the expiry before the host says so reads as expired too (never a dead code with 0:00)', () => {
        const out = html(base, T0 + 121_000);
        expect(out).not.toContain('data-pairing-qr');
        expect(out).toContain('data-pin-ended="expired"');
    });

    it('the ended box keeps the QR’s footprint: both sit in the same fixed-size slot', () => {
        const slot = (out: string) => /data-pair-slot="[^"]*"[^>]*class="([^"]*)"/.exec(out)?.[1] ?? null;
        const live = slot(html(base, T0));
        const gone = slot(html(ended('expired'), T0 + 121_000));
        expect(live).not.toBeNull();
        expect(gone).toBe(live);
    });

    it('New PIN asks for a new PIN; a Re-pair’s New PIN is a Re-pair of the same device', () => {
        const actions: FeatureAction[] = [];
        let el = mount(ended('expired'), T0 + 121_000, (a) => actions.push(a));
        act(() => (el.querySelector('[data-action="new-pin"]') as HTMLButtonElement).click());
        act(() => root?.unmount());
        el.remove();
        el = mount(ended('expired', 'dev_old'), T0 + 121_000, (a) => actions.push(a));
        act(() => (el.querySelector('[data-action="new-pin"]') as HTMLButtonElement).click());
        expect(actions).toEqual([{ kind: 'remote.issuePin' }, { kind: 'remote.issuePin', replaces: 'dev_old' }]);
    });
});

describe('controls', () => {
    it('CONTROL: no PIN and nothing ended shows neither a clock nor an ending, and no QR', () => {
        const out = html({ ...base, pin: null }, T0);
        expect(out).not.toContain('data-pin-left');
        expect(out).not.toContain('data-pin-ended');
        expect(out).not.toContain('data-pairing-qr');
    });

    it('CONTROL: an active PIN still draws the QR carrying the page and the PIN', () => {
        expect(html(base, T0)).toContain('data-qr-value="http://alphar.tailnet.invalid:7421/mobile#pin=482913"');
    });

    it('CONTROL: Pair a device is there either way', () => {
        expect(html(base, T0)).toMatch(/Pair a device/);
        expect(html(ended('expired'), T0 + 121_000)).toMatch(/Pair a device/);
    });
});
