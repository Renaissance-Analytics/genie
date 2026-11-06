import { describe, expect, it } from 'vitest';
import { runsOnElectron } from '../src/core/host-runtime.js';

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
