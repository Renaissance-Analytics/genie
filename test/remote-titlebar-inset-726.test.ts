import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { windowBridge, windowChromeOf } from '../src/renderer/window-address.js';

/**
 * THE PILOT'S BANNER UNDER THE WINDOW BUTTONS (Tynn #726 part 3; the owner's live trial, 2026-11-16). Connected to a
 * client's machine, the remote badge (host, who drives, Disconnect) at the right end of the title bar sat partly under
 * minimize / maximize / close. The bar keeps that space clear by `controlsInset`, from the bridge's `windowChrome`
 * (core/window.ts, window-chrome.ts) — and App took `windowChrome` from the bridge the window READS. Connected, that is
 * the host's bridge (remote-bridge.ts), which has no window chrome: a remote machine draws no buttons on this window. So
 * the inset read 0 exactly while the badge was shown. The buttons are this window's own; so is their space.
 */

type Chrome = { overlay: boolean; tag: string };
type B = { windowChrome?: Chrome | undefined; name: string };
const local: B = { name: 'local', windowChrome: { overlay: true, tag: 'this window' } };
const remote: B = { name: 'remote' }; // the host's bridge: no windowChrome, as remote-bridge.ts builds it

describe('the window buttons are this window’s, whichever machine it reads', () => {
    it('positive control: connected, the window reads the host’s bridge, and it carries no chrome', () => {
        const read = windowBridge({ bound: null, connected: true, remote, local });
        expect(read?.name).toBe('remote');
        expect(read?.windowChrome).toBeUndefined();
    });

    it('connected in place, bound and connected, bound and still connecting, local: this window’s chrome each time', () => {
        expect(windowChromeOf({ local })?.tag).toBe('this window');
        expect(windowChromeOf({ local: undefined })).toBeUndefined();
    });

    it('App hands the title bar this window’s own chrome, not the read bridge’s', () => {
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).toMatch(/windowChrome=\{windowChromeOf\(\{ local: ownBridge \}\)\}/);
        expect(app).not.toMatch(/windowChrome=\{resolvedBridge\?\.windowChrome\}/);
    });
});
