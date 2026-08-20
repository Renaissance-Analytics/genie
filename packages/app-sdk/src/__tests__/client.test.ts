import { describe, expect, it, vi } from 'vitest';
import { createGenieClient, GenieCallError, NotInsideGenieError } from '../client';
import type { GenieAppHost } from '../types';

/**
 * `@genie/app-sdk` — what a Genie App developer writes against (Tynn #250).
 *
 * The SDK is the second half of the security model. The bridge decides what is
 * allowed; the SDK decides what a developer — or the agent writing the app — finds
 * NATURAL to do. A client that made "ask for everything and handle the failure"
 * the path of least resistance would undo the consent screen one convenience
 * method at a time.
 *
 * So it is shaped around three things: know what you were granted (`can`), degrade
 * visibly when you were not (`GenieCallError` carries the user-facing reason), and
 * fail loudly when you are not inside Genie at all, instead of pretending.
 */

const host = (over: Partial<GenieAppHost> = {}): GenieAppHost => ({
    me: async () => ({
        id: 'com.example.trader',
        name: 'Example Trader',
        workspaceId: 'ws-app',
        scope: 'self',
        capabilities: ['hosting'],
    }),
    call: async () => ({ ok: true, result: { content: [] } }),
    ...over,
});

describe('running outside Genie', () => {
    it('says so, rather than failing on an undefined', () => {
        // A developer's `npm run dev` in a normal browser hits this. "Cannot read
        // properties of undefined" would send them hunting through their own code.
        expect(() => createGenieClient(undefined)).toThrow(NotInsideGenieError);
        expect(() => createGenieClient(undefined)).toThrow(/Genie App window/i);
    });

    it('can be asked without throwing, for a UI that wants to degrade', () => {
        const { available } = createGenieClient(undefined, { strict: false });
        expect(available).toBe(false);
    });

    it('refuses calls in the non-strict client too, with the same reason', async () => {
        const client = createGenieClient(undefined, { strict: false });
        await expect(client.call('manageSite')).rejects.toThrow(NotInsideGenieError);
    });
});

describe('knowing what it was granted', () => {
    it('reports a capability it holds', async () => {
        const client = createGenieClient(host());
        expect(await client.can('hosting')).toBe(true);
    });

    it('reports one it does not, so the app can hide the button', async () => {
        // The alternative — offering a control that always fails — teaches the user
        // the app is broken rather than that it is restricted.
        const client = createGenieClient(host());
        expect(await client.can('terminals')).toBe(false);
    });

    it('asks Genie once and remembers', async () => {
        // Permissions do not change mid-session without the app being restarted,
        // and a `can()` behind every render would be an IPC round trip per frame.
        const me = vi.fn(host().me);
        const client = createGenieClient(host({ me }));
        await client.can('hosting');
        await client.can('terminals');
        await client.me();

        expect(me).toHaveBeenCalledTimes(1);
    });

    it('holds no capability at all when Genie does not recognise the window', async () => {
        const client = createGenieClient(host({ me: async () => null }));
        expect(await client.can('hosting')).toBe(false);
    });
});

describe('calling a tool', () => {
    it('hands back the tool’s own result', async () => {
        const client = createGenieClient(
            host({ call: async () => ({ ok: true, result: { sites: ['trader'] } }) }),
        );
        await expect(client.call('manageSite', { action: 'list' })).resolves.toEqual({
            sites: ['trader'],
        });
    });

    it('throws the REASON, in the words the user should read', async () => {
        // The bridge writes refusals for a person ("not granted Host sites and
        // services"). An SDK that replaced that with "Error: 403" would throw the
        // useful half away.
        const client = createGenieClient(
            host({ call: async () => ({ ok: false, error: 'Not granted “Run commands”.' }) }),
        );

        await expect(client.call('manageTerminals')).rejects.toThrow(GenieCallError);
        await expect(client.call('manageTerminals')).rejects.toThrow(/Run commands/);
    });

    it('names the tool on the error, so a UI can say which action failed', async () => {
        const client = createGenieClient(host({ call: async () => ({ ok: false, error: 'no' }) }));

        await expect(client.call('manageTerminals')).rejects.toMatchObject({
            tool: 'manageTerminals',
        });
    });

    it('passes the workspace through when the app targets another one', async () => {
        const call = vi.fn(host().call);
        const client = createGenieClient(host({ call }));
        await client.call('manageSite', { action: 'list' }, { workspaceId: 'ws-other' });

        expect(call).toHaveBeenCalledWith('manageSite', { action: 'list' }, 'ws-other');
    });

    it('survives a host that returns nothing recognisable', async () => {
        const client = createGenieClient(host({ call: async () => undefined as never }));
        await expect(client.call('manageSite')).rejects.toThrow(GenieCallError);
    });
});
