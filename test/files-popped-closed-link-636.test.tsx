// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenieBridge } from '../src/renderer/bridge.js';
import { useFilesPopped } from '../src/renderer/use-files-popped.js';

// Explicit promise-shaped read boundary records escaped failures; the hook and React lifecycle are real.
// This does not claim native transport/unhandled-process coverage and never alters global rejection handlers.
function pendingList() {
    let success: ((value: string[]) => unknown) | undefined;
    let failure: ((error: unknown) => unknown) | undefined;
    const escaped: unknown[] = [];
    const chain = {
        then(ok: (value: string[]) => unknown, bad?: (error: unknown) => unknown) { success = ok; if (bad) failure = bad; return chain; },
        catch(bad: (error: unknown) => unknown) { failure = bad; return chain; },
    };
    return { promise: chain as unknown as Promise<string[]>, escaped, resolve: (value: string[]) => { success?.(value); }, reject: () => {
        const error = new Error('the connection closed');
        if (!failure) escaped.push(error); else { try { failure(error); } catch (thrown) { escaped.push(thrown); } }
    } };
}
function fixture() {
    const read = pendingList();
    const listeners = new Set<(list: string[]) => void>();
    const list = vi.fn(() => read.promise);
    const port: NonNullable<GenieBridge['files']['windows']> = {
        list,
        onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        popOut: async () => {}, bringBack: async () => {},
    };
    return { port, read, list, listeners, push: (value: string[]) => { for (const listener of listeners) listener(value); } };
}
let host: HTMLDivElement; let root: Root; let shown: readonly string[];
function Probe({ port }: { port: GenieBridge['files']['windows'] }) { shown = useFilesPopped(port); return <output>{shown.join(',')}</output>; }
const mount = async (port: GenieBridge['files']['windows']) => { await act(async () => root.render(<Probe port={port} />)); };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('the popped-file-windows caller owns closed-link reads (#636)', () => {
    it('owns a refused initial read and still receives the next real push, without polling', async () => {
        const w = fixture(); await mount(w.port); await act(async () => w.read.reject());
        expect(w.read.escaped).toEqual([]); expect(shown).toEqual([]);
        await act(async () => w.push(['workspace_fixture'])); expect(shown).toEqual(['workspace_fixture']);
        expect(w.list).toHaveBeenCalledTimes(1);
    });

    it('owns a synchronous refusal and installs the push subscription anyway', async () => {
        const w = fixture(); w.list.mockImplementationOnce(() => { throw new Error('the connection closed'); });
        await expect(mount(w.port)).resolves.toBeUndefined();
        await act(async () => w.push(['workspace_fixture'])); expect(shown).toEqual(['workspace_fixture']);
        expect(w.listeners.size).toBe(1);
    });

    it('keeps an already pushed list when the pending read fails', async () => {
        const w = fixture(); await mount(w.port); await act(async () => w.push(['workspace_kept']));
        await act(async () => w.read.reject());
        expect(w.read.escaped).toEqual([]); expect(shown).toEqual(['workspace_kept']);
    });

    it('owns a late refusal after unmount without keeping its listener', async () => {
        const w = fixture(); await mount(w.port); await act(async () => root.render(null));
        await act(async () => w.read.reject());
        expect(w.read.escaped).toEqual([]); expect(w.listeners.size).toBe(0);
    });

    it('owns an old port’s late refusal without changing the new port’s list', async () => {
        const old = fixture(); const next = fixture(); await mount(old.port); await mount(next.port);
        await act(async () => { next.read.resolve(['workspace_current']); old.read.reject(); });
        expect(old.read.escaped).toEqual([]); expect(old.listeners.size).toBe(0);
        expect(shown).toEqual(['workspace_current']);
    });

    it('CONTROL: successful initial and pushed lists work and unsubscribe on unmount', async () => {
        const w = fixture(); await mount(w.port); await act(async () => w.read.resolve(['workspace_first']));
        expect(shown).toEqual(['workspace_first']);
        await act(async () => w.push(['workspace_second'])); expect(shown).toEqual(['workspace_second']);
        await act(async () => root.render(null)); expect(w.listeners.size).toBe(0);
    });

    it('CONTROL: a bridge with no file windows clears the previous list', async () => {
        const w = fixture(); await mount(w.port); await act(async () => w.read.resolve(['workspace_first']));
        await mount(undefined); expect(shown).toEqual([]); expect(w.listeners.size).toBe(0);
    });
});
