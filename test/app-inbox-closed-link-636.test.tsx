// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppInboxBridge } from '../src/renderer/bridge.js';
import { AppInboxCard, type AppInboxCardState } from '../src/renderer/components/AppInboxCard.js';
import { useAppInboxView } from '../src/renderer/use-app-inbox-view.js';

type Reply = Awaited<ReturnType<AppInboxBridge['state']>>;
// Explicit promise-shaped read boundary; actual hook/React lifecycle, no global rejection handlers changed.
function pendingState() {
    let success: ((value: Reply) => unknown) | undefined; let failure: ((error: unknown) => unknown) | undefined;
    const escaped: unknown[] = [];
    const chain = {
        then(ok: (value: Reply) => unknown, bad?: (error: unknown) => unknown) { success = ok; if (bad) failure = bad; return chain; },
        catch(bad: (error: unknown) => unknown) { failure = bad; return chain; },
    };
    return { promise: chain as unknown as Promise<Reply>, escaped, resolve: (value: Reply) => { success?.(value); }, reject: () => {
        const error = new Error('the connection closed: synthetic internal detail\n    at fixture/internal.ts:1:2');
        if (!failure) escaped.push(error); else { try { failure(error); } catch (thrown) { escaped.push(thrown); } }
    } };
}
function fixture() {
    const reads: ReturnType<typeof pendingState>[] = [];
    const state = vi.fn((_id: string) => { const read = pendingState(); reads.push(read); return read.promise; });
    return { reads, state, bridge: { state } as unknown as AppInboxBridge };
}
const saved: AppInboxCardState = { url: null, enabled: false, sources: [], revoked: [], scriptKeys: [] };
let host: HTMLDivElement; let root: Root; let shown: ReturnType<typeof useAppInboxView>[0];
function Probe({ bridge, id, refresh }: { bridge: AppInboxBridge | undefined; id: string | null; refresh: number }) { [shown] = useAppInboxView(bridge, id, refresh); return <output>{shown?.workspaceId}</output>; }
const mount = async (bridge: AppInboxBridge | undefined, id: string | null = 'workspace_fixture', refresh = 0) => { await act(async () => root.render(<Probe bridge={bridge} id={id} refresh={refresh} />)); };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('the initial Apps and scripts read handles a closed link (#636)', () => {
    it('owns the refusal, reports it plainly and retries the same read only when asked', async () => {
        const w = fixture(); await mount(w.bridge); await act(async () => w.reads[0]!.reject());
        expect(w.reads[0]!.escaped).toEqual([]); expect(shown?.state).toBeNull();
        expect(shown?.outcome?.ok).toBe(false); expect(shown?.outcome?.text).toMatch(/could not be loaded/i);
        expect(shown?.outcome?.text).not.toMatch(/synthetic|internal\.ts|\n\s*at /);
        expect(w.state).toHaveBeenCalledTimes(1); expect(shown?.outcome?.retry).toBeTypeOf('function');
        await act(async () => shown?.outcome?.retry?.()); expect(w.state).toHaveBeenNthCalledWith(2, 'workspace_fixture');
        await act(async () => w.reads[1]!.resolve({ ok: true, state: saved }));
        expect(shown?.state).toEqual(saved); expect(shown?.outcome).toBeNull();
    });

    it('owns a synchronous state-read refusal', async () => {
        const w = fixture(); w.state.mockImplementationOnce(() => { throw new Error('the connection closed'); });
        await expect(mount(w.bridge)).resolves.toBeUndefined();
        expect(shown?.outcome?.ok).toBe(false); expect(shown?.outcome?.retry).toBeTypeOf('function');
    });

    it('owns a late refusal after unmount without retrying', async () => {
        const w = fixture(); await mount(w.bridge); await act(async () => root.render(null));
        await act(async () => w.reads[0]!.reject());
        expect(w.reads[0]!.escaped).toEqual([]); expect(w.state).toHaveBeenCalledTimes(1);
    });

    it('does not let an old workspace/bridge refusal replace the new workspace view', async () => {
        const old = fixture(); const next = fixture(); await mount(old.bridge); await mount(next.bridge, 'workspace_next');
        await act(async () => { next.reads[0]!.resolve({ ok: true, state: saved }); old.reads[0]!.reject(); });
        expect(old.reads[0]!.escaped).toEqual([]); expect(shown?.workspaceId).toBe('workspace_next');
        expect(shown?.state).toEqual(saved); expect(shown?.outcome).toBeNull();
    });

    it('renders an initial-read failure and Retry while state is still unknown instead of hiding it behind a skeleton', () => {
        const noop = () => {};
        const html = renderToStaticMarkup(<AppInboxCard state={null} busy={null} revealed={null} outcome={{ ok: false, text: 'Apps and scripts could not be loaded. Try again.', retry: noop }} now={0} onCreateKey={noop} onRevokeKey={noop} onRotate={noop} onRevoke={noop} onAllow={noop} onDismissReveal={noop} />);
        expect(html).toContain('role="alert"'); expect(html).toContain('Apps and scripts could not be loaded.');
        expect(html).toContain('data-action="app-retry"'); expect(html).not.toContain('data-app-inbox-skeleton');
    });

    it('CONTROL: success and an existing refresh notification load the real state without a failure', async () => {
        const w = fixture(); await mount(w.bridge); await act(async () => w.reads[0]!.resolve({ ok: true, state: saved }));
        expect(shown?.state).toEqual(saved); expect(shown?.outcome).toBeNull();
        await mount(w.bridge, 'workspace_fixture', 1); expect(w.state).toHaveBeenCalledTimes(2);
        const changed = { ...saved, enabled: true }; await act(async () => w.reads[1]!.resolve({ ok: true, state: changed }));
        expect(shown?.state).toEqual(changed);
    });

    it('CONTROL: a remote/missing local port or missing workspace clears the view and sends no further read', async () => {
        const w = fixture(); await mount(w.bridge); await act(async () => w.reads[0]!.resolve({ ok: true, state: saved }));
        await mount(undefined); expect(shown).toBeNull();
        await mount(w.bridge, null); expect(shown).toBeNull(); expect(w.state).toHaveBeenCalledTimes(1);
    });
});
