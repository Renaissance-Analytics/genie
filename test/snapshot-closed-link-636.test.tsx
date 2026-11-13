// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_SNAPSHOT, type GenieBridge, type GenieSnapshot } from '../src/renderer/bridge.js';
import { useSnapshot } from '../src/renderer/use-snapshot.js';

// A controllable promise-shaped host boundary records otherwise-unhandled refusals without changing Vitest's
// global rejection handlers. The actual hook, React lifetime, subscriptions and state sharing remain under test.
function pendingRead<T>() {
    let success: ((value: T) => unknown) | undefined;
    let failure: ((error: unknown) => unknown) | undefined;
    const escaped: unknown[] = [];
    const chain = {
        then(ok: (value: T) => unknown, bad?: (error: unknown) => unknown) { success = ok; if (bad) failure = bad; return chain; },
        catch(bad: (error: unknown) => unknown) { failure = bad; return chain; },
    };
    return {
        promise: chain as unknown as Promise<T>, escaped,
        resolve: (value: T) => { success?.(value); },
        reject: (error: unknown) => { if (!failure) escaped.push(error); else { try { failure(error); } catch (thrown) { escaped.push(thrown); } } },
    };
}
function rig() {
    const read = pendingRead<GenieSnapshot>(); const listeners = new Set<(value: GenieSnapshot) => void>();
    const snapshot = vi.fn(() => read.promise);
    const bridge = { snapshot, subscribe: (listener: (value: GenieSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    return { bridge, snapshot, read, listeners, push: (value: GenieSnapshot) => { for (const listener of listeners) listener(value); } };
}
let host: HTMLDivElement; let root: Root; let shown: GenieSnapshot;
function Probe({ bridge }: { bridge: Pick<GenieBridge, 'snapshot' | 'subscribe'> }) {
    shown = useSnapshot(bridge);
    return <output>{shown.workspaces === null ? 'loading' : 'loaded'}</output>;
}
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    shown = EMPTY_SNAPSHOT; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = async (bridge: Pick<GenieBridge, 'snapshot' | 'subscribe'>): Promise<void> => { await act(async () => { root.render(<Probe bridge={bridge} />); }); };
const closed = new Error('the connection closed');

describe('the snapshot caller owns a closed-link outcome (#636)', () => {
    it('handles the initial read refusal, keeps loading honest and recovers from the next live push', async () => {
        const w = rig(); await mount(w.bridge);
        await act(async () => { w.read.reject(closed); });
        expect(w.read.escaped).toEqual([]);
        expect(shown.workspaces).toBeNull();
        const recovered = { ...EMPTY_SNAPSHOT, workspaces: [] };
        act(() => w.push(recovered)); expect(shown).toEqual(recovered);
        expect(w.snapshot).toHaveBeenCalledTimes(1);
    });

    it('contains a synchronous read refusal and still installs the push subscription', async () => {
        const w = rig(); w.snapshot.mockImplementationOnce(() => { throw closed; });
        await expect(mount(w.bridge)).resolves.toBeUndefined();
        expect(w.listeners.size).toBe(1);
        const recovered = { ...EMPTY_SNAPSHOT, workspaces: [] };
        act(() => w.push(recovered)); expect(shown).toEqual(recovered);
    });

    it('keeps the latest pushed estate if the earlier initial read then fails', async () => {
        const w = rig(); await mount(w.bridge); const current = { ...EMPTY_SNAPSHOT, deckItems: [] };
        act(() => w.push(current));
        await act(async () => { w.read.reject(closed); });
        expect(shown).toEqual(current); expect(w.read.escaped).toEqual([]);
    });

    it('handles a late refusal after unmount without a lingering subscription', async () => {
        const w = rig(); await mount(w.bridge); act(() => root.render(null));
        await act(async () => { w.read.reject(closed); });
        expect(w.read.escaped).toEqual([]); expect(w.listeners.size).toBe(0);
    });

    it('handles the old host closing after a switch without disturbing the new host', async () => {
        const old = rig(); const next = rig(); await mount(old.bridge); await mount(next.bridge);
        const current = { ...EMPTY_SNAPSHOT, deckItems: [] };
        await act(async () => { next.read.resolve(current); });
        await act(async () => { old.read.reject(closed); });
        expect(shown).toEqual(current); expect(old.read.escaped).toEqual([]);
        expect(old.listeners.size).toBe(0); expect(next.listeners.size).toBe(1);
    });

    it('CONTROL: successful initial reads and live pushes still update the estate', async () => {
        const w = rig(); await mount(w.bridge); const initial = { ...EMPTY_SNAPSHOT, workspaces: [] };
        await act(async () => { w.read.resolve(initial); }); expect(shown).toEqual(initial);
        const current = { ...initial, deckItems: [] };
        act(() => w.push(current)); expect(shown).toEqual(current);
        expect(w.read.escaped).toEqual([]);
    });

    it('CONTROL: an old host success after a switch cannot replace the new estate', async () => {
        const old = rig(); const next = rig(); await mount(old.bridge); await mount(next.bridge);
        const current = { ...EMPTY_SNAPSHOT, deckItems: [] };
        await act(async () => { next.read.resolve(current); });
        await act(async () => { old.read.resolve({ ...EMPTY_SNAPSHOT, workspaces: [] }); });
        expect(shown).toEqual(current); expect(old.listeners.size).toBe(0);
    });
});
