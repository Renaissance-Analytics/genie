import { describe, it, expect, vi } from 'vitest';
import { wireHostLossRecovery, type HostLossEmitter } from '../host-service';

/**
 * Fix C detection wiring (genie#203). The package emits the host client's
 * one-shot 'error' on socket close/error but only reverts to in-process. This
 * arms that signal to the recovery orchestrator and — crucially — RE-ARMS onto
 * whatever client is active after recovery (the respawned host), so a second
 * death is caught too. When recovery falls back to in-process (no host), there
 * is nothing left to watch.
 */

function fakeClient() {
    const listeners: Array<() => unknown> = [];
    const client: HostLossEmitter = {
        once(_event: 'error', cb: () => unknown) {
            listeners.push(cb);
        },
    };
    return {
        client,
        listenerCount: () => listeners.length,
        async fire() {
            const ls = listeners.splice(0);
            await Promise.all(ls.map((l) => l()));
        },
    };
}

describe('wireHostLossRecovery', () => {
    it('arms onto the active client at construction', () => {
        const a = fakeClient();
        const w = wireHostLossRecovery({
            getActiveClient: () => a.client,
            recover: vi.fn(async () => {}),
        });
        expect(w.armed()).toBe(true);
        expect(a.listenerCount()).toBe(1);
    });

    it('runs recovery once when the client reports a loss', async () => {
        const a = fakeClient();
        const recover = vi.fn(async () => {});
        wireHostLossRecovery({ getActiveClient: () => a.client, recover });

        await a.fire();

        expect(recover).toHaveBeenCalledTimes(1);
    });

    it('re-arms onto the respawned client so a second loss is also caught', async () => {
        const a = fakeClient();
        const b = fakeClient();
        let active = a;
        const recover = vi.fn(async () => {
            active = b; // recovery respawned a fresh host → a new client
        });
        const w = wireHostLossRecovery({
            getActiveClient: () => active.client,
            recover,
        });

        await a.fire(); // loss on A → recover → re-arm onto B
        expect(recover).toHaveBeenCalledTimes(1);
        expect(w.armed()).toBe(true);

        await b.fire(); // loss on B → recover again
        expect(recover).toHaveBeenCalledTimes(2);
    });

    it('stops watching when recovery falls back to in-process (no client)', async () => {
        const a = fakeClient();
        let active: ReturnType<typeof fakeClient> | null = a;
        const recover = vi.fn(async () => {
            active = null; // degraded to in-process — nothing to watch
        });
        const w = wireHostLossRecovery({
            getActiveClient: () => active?.client ?? null,
            recover,
        });

        await a.fire();

        expect(w.armed()).toBe(false);
    });

    it('does not double-subscribe to the same client', () => {
        const a = fakeClient();
        const w = wireHostLossRecovery({
            getActiveClient: () => a.client,
            recover: vi.fn(async () => {}),
        });
        w.rearm();
        w.rearm();
        expect(a.listenerCount()).toBe(1);
    });
});
