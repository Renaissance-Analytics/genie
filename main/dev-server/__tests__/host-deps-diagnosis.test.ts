import { describe, expect, it } from 'vitest';
import { diagnoseHostSpawnFailure } from '../host-deps-diagnosis';

/**
 * Why a host-native site's dev server died on its first breath (genie#227).
 *
 * Reported from a workspace migrating off container hosting: the site failed
 * instantly with
 *
 *     'vite' is not recognized as an internal or external command
 *
 * which names the binary and says nothing about the cause. The cause was that the
 * repo's dependencies had only ever been installed INSIDE the Linux sandbox, so
 * `node_modules/.bin` held POSIX shims and no `.cmd`/`.ps1` — invisible to a
 * Windows host process. A host-side `npm install` fixed it.
 *
 * Every workspace moving from container hosting to host-native hits this, and the
 * error points at the wrong thing every time. So Genie says the cause.
 */

const notRecognized = "'vite' is not recognized as an internal or external command";

describe('dependencies installed for another platform', () => {
    it('names the cause when .bin has POSIX shims but no Windows ones', () => {
        const note = diagnoseHostSpawnFailure({
            log: notRecognized,
            platform: 'win32',
            binEntries: ['vite', 'esbuild', 'tsc'],
        });

        expect(note).toMatch(/node_modules/);
        expect(note).toMatch(/npm install/i);
        // The specific insight — these were installed somewhere else.
        expect(note).toMatch(/another platform|different platform|inside the sandbox/i);
    });

    it('says nothing when the Windows shims ARE there', () => {
        // Then the failure is something else, and a confident wrong diagnosis is
        // worse than none.
        expect(
            diagnoseHostSpawnFailure({
                log: notRecognized,
                platform: 'win32',
                binEntries: ['vite', 'vite.cmd', 'vite.ps1'],
            }),
        ).toBeNull();
    });
});

describe('dependencies not installed at all', () => {
    it('says so, which is a different fix from a platform mismatch', () => {
        const note = diagnoseHostSpawnFailure({
            log: notRecognized,
            platform: 'win32',
            binEntries: null,
        });

        expect(note).toMatch(/npm install/i);
        expect(note).not.toMatch(/another platform/i);
    });
});

describe('not this problem', () => {
    it('stays silent when the failure is not a missing binary', () => {
        expect(
            diagnoseHostSpawnFailure({
                log: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:5173',
                platform: 'win32',
                binEntries: ['vite'],
            }),
        ).toBeNull();
    });

    it('stays silent on an empty log rather than guessing', () => {
        expect(
            diagnoseHostSpawnFailure({ log: '', platform: 'win32', binEntries: ['vite'] }),
        ).toBeNull();
    });

    it('recognises the POSIX spelling of the same failure', () => {
        // `sh: vite: not found` is the macOS/Linux form; the mismatch runs the
        // other way when a Windows-installed tree is used from WSL.
        const note = diagnoseHostSpawnFailure({
            log: 'sh: 1: vite: not found',
            platform: 'linux',
            binEntries: ['vite.cmd', 'vite.ps1'],
        });
        expect(note).toMatch(/npm install/i);
    });

    it('does not blame the platform when a POSIX box has POSIX shims', () => {
        expect(
            diagnoseHostSpawnFailure({
                log: 'sh: 1: vite: not found',
                platform: 'linux',
                binEntries: ['vite'],
            }),
        ).toBeNull();
    });
});
