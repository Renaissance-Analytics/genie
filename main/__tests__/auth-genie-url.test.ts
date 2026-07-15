import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from 'electron';

/**
 * Routing tests for handleGenieUrl (main/auth.ts) — the single entry point the
 * OS calls for every incoming `genie://` URL.
 *
 * We mock the heavy edges (the workstation CONNECT pipeline, the main window,
 * the Tynn backend) so these exercise ONLY the URL parsing + dispatch + the
 * signed-out defer/replay, not the relay dial.
 */

const mocks = vi.hoisted(() => ({
    // Flip between signed-out (null) and signed-in per test.
    whoamiUser: null as null | { id: string; name: string; email: string },
    connectable: [] as Array<{ id: string; name: string }>,
    // Countable so we can assert redeemCode does a SINGLE whoami (no redundant
    // second exchange of the now-consumed token).
    whoami: vi.fn(async () => mocks.whoamiUser),
    openWorkstationById: vi.fn(async (_id: string, _name?: string) => ({
        ok: true as boolean,
        connKey: 'ck',
        error: undefined as string | undefined,
    })),
    showMainWindow: vi.fn(),
}));

vi.mock('../db', () => ({ getAllSettings: () => ({}) }));
vi.mock('../background', () => ({
    showMainWindow: mocks.showMainWindow,
    showHostWindow: vi.fn(),
}));
vi.mock('../workstation-open', () => ({
    openWorkstationById: mocks.openWorkstationById,
}));
vi.mock('../backend/registry', () => ({
    getTynnBackend: () => ({
        whoami: mocks.whoami,
        host: () => 'https://tynn.test',
        listConnectableWorkstations: async () => mocks.connectable,
    }),
}));

import { handleGenieUrl, redeemCode } from '../auth';

beforeEach(() => {
    mocks.whoamiUser = null;
    mocks.connectable = [];
    mocks.openWorkstationById.mockClear();
    mocks.openWorkstationById.mockResolvedValue({ ok: true, connKey: 'ck', error: undefined });
    mocks.showMainWindow.mockClear();
    mocks.whoami.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('handleGenieUrl', () => {
    it('routes genie://workstation/open?id=… to openWorkstationById when signed in', async () => {
        mocks.whoamiUser = { id: 'u1', name: 'U', email: '' };

        await handleGenieUrl('genie://workstation/open?id=WS1&name=My%20Box');

        expect(mocks.openWorkstationById).toHaveBeenCalledTimes(1);
        expect(mocks.openWorkstationById).toHaveBeenCalledWith('WS1', 'My Box');
    });

    it('still redeems the oauth/callback token (existing branch intact)', async () => {
        mocks.whoamiUser = { id: 'u1', name: 'U', email: '' };

        await handleGenieUrl('genie://oauth/callback?token=abc123');

        // redeemToken → whoami() truthy → main window surfaced; no workstation open.
        expect(mocks.showMainWindow).toHaveBeenCalledTimes(1);
        expect(mocks.openWorkstationById).not.toHaveBeenCalled();
    });

    it('defers the open when signed out, then replays it after sign-in', async () => {
        mocks.whoamiUser = null; // signed out
        mocks.connectable = [{ id: 'WS2', name: 'Resolved Box' }];
        const openExternal = vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined);

        // Deep link arrives signed-out: it must NOT open yet — it kicks off sign-in.
        await handleGenieUrl('genie://workstation/open?id=WS2');
        expect(mocks.openWorkstationById).not.toHaveBeenCalled();
        expect(openExternal).toHaveBeenCalledTimes(1); // startSignIn opened the browser

        // Sign-in completes → the deferred open replays, resolving the name by id.
        mocks.whoamiUser = { id: 'u1', name: 'U', email: '' };
        await handleGenieUrl('genie://oauth/callback?token=tok');

        await vi.waitFor(() => expect(mocks.openWorkstationById).toHaveBeenCalledTimes(1));
        expect(mocks.openWorkstationById).toHaveBeenCalledWith('WS2', 'Resolved Box');
    });

    it('ignores an unknown genie:// host without throwing', async () => {
        await expect(handleGenieUrl('genie://nope/whatever')).resolves.toBeUndefined();
        expect(mocks.openWorkstationById).not.toHaveBeenCalled();
    });
});

describe('redeemCode — manual code-paste path', () => {
    it('signs in with a SINGLE whoami (reuses redeemToken result, no second exchange)', async () => {
        mocks.whoamiUser = { id: 'u1', name: 'U', email: '' };

        const ok = await redeemCode('paste-me');

        expect(ok).toBe(true);
        // The old code called whoami twice (once in redeemToken, once again in
        // redeemCode against the now-consumed token) — the second re-exchange is
        // exactly what produced spurious "already used" after a real sign-in.
        expect(mocks.whoami).toHaveBeenCalledTimes(1);
        expect(mocks.showMainWindow).toHaveBeenCalledTimes(1);
    });

    it('returns false when the code does not sign us in', async () => {
        mocks.whoamiUser = null;

        expect(await redeemCode('bad-code')).toBe(false);
        expect(mocks.whoami).toHaveBeenCalledTimes(1);
    });

    it('rejects empty / oversized input without touching the backend', async () => {
        expect(await redeemCode('   ')).toBe(false);
        expect(await redeemCode('x'.repeat(257))).toBe(false);
        expect(mocks.whoami).not.toHaveBeenCalled();
    });
});
