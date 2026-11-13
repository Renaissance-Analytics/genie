// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLink } from '../src/main/tynn-share-links.js';
import type { TynnNetworkBridge } from '../src/renderer/relay-transport.js';
import { ShareWorkspaceForm } from '../src/renderer/components/ShareWorkspaceModal.js';
import { useShareView, type ShareView } from '../src/renderer/use-share-view.js';

type Shares = NonNullable<TynnNetworkBridge['shares']>;
// Explicit promise-shaped boundary, real controller/React lifecycle; no runner global rejection handlers changed.
function pending<T>() {
    let success: ((value: T) => unknown) | undefined; let failure: ((error: unknown) => unknown) | undefined;
    const escaped: unknown[] = [];
    const chain = {
        then(ok: (value: T) => unknown, bad?: (error: unknown) => unknown) { success = ok; if (bad) failure = bad; return chain; },
        catch(bad: (error: unknown) => unknown) { failure = bad; return chain; },
    };
    return { promise: chain as unknown as Promise<T>, escaped, resolve: (value: T) => { success?.(value); }, reject: () => {
        const error = new Error('the connection closed: synthetic internal detail\n    at fixture/internal.ts:1:2');
        if (!failure) escaped.push(error); else { try { failure(error); } catch (thrown) { escaped.push(thrown); } }
    } };
}
function fixture() {
    const lists: ReturnType<typeof pending<Awaited<ReturnType<Shares['list']>>>>[] = [];
    const mints: ReturnType<typeof pending<Awaited<ReturnType<Shares['mint']>>>>[] = [];
    const list = vi.fn((_id: string | null) => { const read = pending<Awaited<ReturnType<Shares['list']>>>(); lists.push(read); return read.promise; });
    const mint = vi.fn((_input: Parameters<Shares['mint']>[0]) => { const write = pending<Awaited<ReturnType<Shares['mint']>>>(); mints.push(write); return write.promise; });
    const bridge: Shares = { list, mint, revoke: async () => ({ ok: true }) };
    return { bridge, list, mint, lists, mints };
}
const listed: ShareLink = { id: 'share_fixture', url: null, capability: 'readonly', whole: false, workspaceIds: ['workspace_fixture'], expiresAt: null, claimed: false };
const made: ShareLink = { ...listed, url: 'https://example.com/share/fixture' };
const input = { capability: 'readonly' as const, expiresInDays: 7, whole: false };
const initial = (workspaceId: string | null = 'workspace_fixture'): ShareView => ({ workspaceId, name: 'fixture', links: null, minted: null, problem: null, busy: false });
let host: HTMLDivElement; let root: Root; let view: ReturnType<typeof useShareView>;
function Probe({ shares }: { shares: Shares }) { view = useShareView(shares); return <output>{view.share?.name}</output>; }
const mount = async (shares: Shares) => { await act(async () => root.render(<Probe shares={shares} />)); };
const open = async () => { await act(async () => { view.setShare(initial()); view.readShares('workspace_fixture'); }); };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const plain = (text: string | null | undefined) => { expect(text).toBeTruthy(); expect(text).not.toMatch(/synthetic|internal\.ts|\n\s*at /); };

describe('the selected owner’s share requests handle a closed link (#636)', () => {
    it('owns list rejection, keeps the initial list unknown and reports failure plainly', async () => {
        const w = fixture(); await mount(w.bridge); await open(); await act(async () => w.lists[0]!.reject());
        expect(w.lists[0]!.escaped).toEqual([]); expect(view.share?.links).toBeNull();
        plain(view.share?.problem); expect(w.list).toHaveBeenCalledTimes(1);
    });

    it('owns a synchronous list refusal', async () => {
        const w = fixture(); w.list.mockImplementationOnce(() => { throw new Error('the connection closed'); }); await mount(w.bridge);
        await expect(open()).resolves.toBeUndefined(); plain(view.share?.problem); expect(view.share?.links).toBeNull();
    });

    it('keeps previously read links on a host refusal instead of claiming they disappeared', async () => {
        const w = fixture(); await mount(w.bridge); await open(); await act(async () => w.lists[0]!.resolve({ ok: true, links: [listed] }));
        await act(async () => view.readShares('workspace_fixture'));
        await act(async () => w.lists[1]!.resolve({ ok: false, reason: 'synthetic permission refusal' }));
        expect(view.share?.links).toEqual([listed]); expect(view.share?.problem).toBe('synthetic permission refusal');
    });

    it('owns create rejection, ends busy and never invents a URL or retries uncertain creation', async () => {
        const w = fixture(); await mount(w.bridge); await open(); await act(async () => view.mintShare(input));
        expect(view.share?.busy).toBe(true); await act(async () => w.mints[0]!.reject());
        expect(w.mints[0]!.escaped).toEqual([]); expect(view.share?.busy).toBe(false); expect(view.share?.minted).toBeNull();
        plain(view.share?.problem); expect(w.mint).toHaveBeenCalledTimes(1); expect(w.list).toHaveBeenCalledTimes(1);
    });

    it('owns synchronous create refusal and ends busy', async () => {
        const w = fixture(); w.mint.mockImplementationOnce(() => { throw new Error('the connection closed'); }); await mount(w.bridge); await open();
        await expect(act(async () => view.mintShare(input))).resolves.toBeUndefined();
        expect(view.share?.busy).toBe(false); expect(view.share?.minted).toBeNull(); plain(view.share?.problem);
    });

    it('owns a late create failure without overwriting another workspace’s view or replaying', async () => {
        const w = fixture(); await mount(w.bridge); await open(); await act(async () => view.mintShare(input));
        await act(async () => view.setShare(initial('workspace_next'))); await act(async () => w.mints[0]!.reject());
        expect(w.mints[0]!.escaped).toEqual([]); expect(view.share).toEqual(initial('workspace_next')); expect(w.mint).toHaveBeenCalledTimes(1);
    });

    it('shows an unknown-list failure without still claiming to ask Tynn or claiming there are no links', () => {
        const html = renderToStaticMarkup(<ShareWorkspaceForm workspaceName="fixture" links={null} minted={null} problem="Share links could not be loaded." busy={false} onClose={() => {}} onMint={() => {}} onRevoke={async () => ({ ok: true })} />);
        expect(html).toContain('Share links could not be loaded.'); expect(html).not.toContain('Asking Tynn'); expect(html).not.toContain('>None.</');
    });

    it('CONTROL: successful listing and creation keep the requested scope/capability, actual URL and list refresh', async () => {
        const w = fixture(); await mount(w.bridge); await open(); await act(async () => w.lists[0]!.resolve({ ok: true, links: [listed] }));
        expect(view.share?.links).toEqual([listed]); await act(async () => view.mintShare(input));
        expect(w.mint).toHaveBeenCalledWith({ workspaceId: 'workspace_fixture', capability: 'readonly', expiresInDays: 7 });
        await act(async () => w.mints[0]!.resolve({ ok: true, link: made }));
        expect(view.share?.busy).toBe(false); expect(view.share?.minted).toEqual(made); expect(view.share?.problem).toBeNull();
        expect(w.list).toHaveBeenNthCalledWith(2, 'workspace_fixture'); await act(async () => w.lists[1]!.resolve({ ok: true, links: [listed] }));
        expect(view.share?.links).toEqual([listed]); expect(view.share?.minted).toEqual(made);
    });

    it('CONTROL: only an explicit whole-workstation choice broadens the creation request', async () => {
        const w = fixture(); await mount(w.bridge); await open(); await act(async () => view.mintShare({ ...input, whole: true }));
        expect(w.mint).toHaveBeenCalledWith({ workspaceId: null, capability: 'readonly', expiresInDays: 7 });
        await act(async () => w.mints[0]!.resolve({ ok: false, reason: 'host refused creation' }));
        expect(view.share?.busy).toBe(false); expect(view.share?.problem).toBe('host refused creation'); expect(w.mint).toHaveBeenCalledTimes(1);
    });
});
