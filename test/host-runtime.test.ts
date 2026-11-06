import { describe, expect, it } from 'vitest';
import { NO_PAGES_HERE, NO_UPDATES_HERE, hostCapabilities, notAvailableHere, runsOnElectron } from '../src/core/host-runtime.js';

/**
 * WHAT GENIE-HOST RUNS ON (P10.1d). In the app: Electron's binary as Node, which says so in `process.versions.electron`.
 * In genie-cloud's container: plain Node, which has no such entry — and no Electron to start the browser with.
 */
describe('runsOnElectron', () => {
    it('plain Node: no', () => {
        expect(runsOnElectron({ node: '22.13.0', v8: '12.4' })).toBe(false);
    });

    it('Electron as Node: yes (CONTROL)', () => {
        expect(runsOnElectron({ node: '22.20.0', electron: '45.1.0' })).toBe(true);
    });

    it('this process, the test runner, is plain Node (CONTROL: the default reads process.versions)', () => {
        expect(runsOnElectron()).toBe(process.versions.electron !== undefined);
    });
});

/**
 * WHAT THIS HOST CAN HAVE (P10.1d), decided in one place. On plain Node: no Genie window to forward a tool to, no Genie
 * browser, no OS elevation (it is asked in a window). Electron as Node: all three, as today.
 */
describe('hostCapabilities', () => {
    it('plain Node: no window, no browser, no elevation', () => {
        expect(hostCapabilities({ node: '22.16.0' })).toEqual({ window: false, browser: false, elevation: false });
    });

    it('CONTROL: Electron as Node: all three', () => {
        expect(hostCapabilities({ node: '22.20.0', electron: '45.1.0' })).toEqual({ window: true, browser: true, elevation: true });
    });

    it('the one wording: "<what> is not available on this host", why, and that nothing was done — pages\' too', () => {
        expect(notAvailableHere('sites', 'a Genie window')).toBe('sites is not available on this host: it runs on plain Node, with no Electron for a Genie window. Nothing was done.');
        expect(NO_PAGES_HERE).toBe(notAvailableHere('pages', 'the Genie browser'));
        expect(NO_UPDATES_HERE).toBe("Updates aren't available on this host: its image is updated by its deployment.");
    });
});
