import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The seam that turns "encryption is unavailable" into WHICH of the three Linux
 * faults it is (genie#588). Two surfaces read it — the GitHub panel's hint and
 * the remote pairing prompt — and until now only one of them could tell the
 * difference, which is how a machine with a healthy, unlocked, `gh`-serving
 * keyring spent six days being told its keychain was unavailable.
 */

const h = vi.hoisted(() => ({
    backend: 'basic_text' as string,
    owned: true,
    probes: 0,
    /** Stand in for an Electron build where the Linux-only API is absent or
     *  throws — the diagnostic must not take the caller down with it. */
    backendThrows: false,
}));

vi.mock('electron', () => ({
    safeStorage: {
        getSelectedStorageBackend: () => {
            if (h.backendThrows) throw new Error('not implemented');
            return h.backend;
        },
    },
}));

vi.mock('../linux-password-store', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../linux-password-store')>();
    return {
        ...actual,
        probeOwnedBusNames: (names: string[]) => {
            h.probes += 1;
            return h.owned ? names : [];
        },
    };
});

import { classifyKeychainFault } from '../linux-password-store';
import {
    currentKeychainState,
    resetKeychainStateCache,
    selectedKeychainBackend,
} from '../keychain-state';

const REAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
    h.backend = 'basic_text';
    h.owned = true;
    h.probes = 0;
    h.backendThrows = false;
    resetKeychainStateCache();
    setPlatform('linux');
});
afterEach(() => {
    setPlatform(REAL_PLATFORM);
    resetKeychainStateCache();
});

describe('currentKeychainState', () => {
    it('reports a live keyring + the plaintext store as GENIE not selecting one', () => {
        h.owned = true;
        h.backend = 'basic_text';
        expect(classifyKeychainFault(currentKeychainState())).toBe('not-selected');
    });

    it('reports a live keyring + a real backend as the keyring REFUSING', () => {
        // Same `isEncryptionAvailable() === false`, different fault and a
        // different remedy. Conflating these two is the bug.
        h.owned = true;
        h.backend = 'gnome_libsecret';
        expect(classifyKeychainFault(currentKeychainState())).toBe('refused');
    });

    it('reports nothing on the bus as a genuinely missing service', () => {
        h.owned = false;
        h.backend = 'basic_text';
        expect(classifyKeychainFault(currentKeychainState())).toBe('no-service');
    });

    it('caches, so polling a broken state does not spawn a process per tick', () => {
        currentKeychainState();
        currentKeychainState();
        currentKeychainState();
        expect(h.probes).toBe(1);
        // Positive control: the cache is what suppressed those, not a probe that
        // never runs — clearing it makes the next read shell out again.
        resetKeychainStateCache();
        currentKeychainState();
        expect(h.probes).toBe(2);
    });

    it('never touches the session bus off Linux', () => {
        setPlatform('win32');
        const state = currentKeychainState();
        expect(h.probes).toBe(0);
        expect(state.selectedBackend).toBeNull();
        expect(classifyKeychainFault(state)).toBe('not-linux');
    });
});

describe('selectedKeychainBackend', () => {
    it('hands over the store Electron reports, verbatim', () => {
        h.backend = 'kwallet6';
        expect(selectedKeychainBackend()).toBe('kwallet6');
    });

    it('is null off Linux, where the API does not exist', () => {
        setPlatform('darwin');
        expect(selectedKeychainBackend()).toBeNull();
    });

    it('survives an Electron build without the API rather than breaking the caller', () => {
        h.backendThrows = true;
        expect(() => selectedKeychainBackend()).not.toThrow();
        expect(selectedKeychainBackend()).toBeNull();
        // …and the state read on top of it still answers, so a pairing prompt
        // gets a reason rather than an exception.
        expect(() => currentKeychainState()).not.toThrow();
        expect(classifyKeychainFault(currentKeychainState())).toBe('not-selected');
    });
});
