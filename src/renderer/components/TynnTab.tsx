import { Icon } from '@particle-academy/react-fancy';
import { useCallback, useEffect, useRef, useState } from 'react';
import { performBoardAction, performClaimThenStart, type BoardActionInput, type BoardOp, type LiveState } from '../../core/tynn-board.js';
import { PageFollower, TYNN_FIRST_SECTION, TYNN_SECTIONS, type TynnPage, type TynnPageActionInput, type TynnPageQuery, type TynnPageState, type TynnPageView, type TynnSectionId, type TynnTabHost, type HomeView, type ReleasesView, type VipView, type WipLens, type WipView } from '../../core/tynn-pages.js';
import { TynnBoardTab } from './TynnBoardPanel.js';
import { TynnHomePanel } from './TynnHomePanel.js';
import { TynnReleasesPanel } from './TynnReleasesPanel.js';
import { TynnVipPanel } from './TynnVipPanel.js';
import { TynnWipPanel } from './TynnWipPanel.js';

/**
 * THE TYNN TAB (genie#1295): tynn.ai's workspace for the workspace's own project — its pages in tynn.ai's order with
 * tynn.ai's icons, and no user menu or project picker (the owner: "full parity … minus the user and project menus").
 * The board keeps its own tab component (TynnBoardPanel.tsx); each other page has its own panel, read through the host's
 * `page` door. A page joins the nav (core/tynn-pages.ts TYNN_SECTIONS) when it is built.
 */

/** The page nav: an icon per page, named for a screen reader (the owner: icons over words). */
export function TynnSectionNav({ current, onSection }: { current: TynnSectionId; onSection: (id: TynnSectionId) => void }) {
    return (
        <nav aria-label="Tynn" className="flex items-center gap-0.5 border-b border-[var(--border-1)] px-2 py-1">
            {TYNN_SECTIONS.map((s) => {
                const on = s.id === current;
                return (
                    <button
                        key={s.id}
                        type="button"
                        data-tynn-section={s.id}
                        aria-label={s.label}
                        title={s.label}
                        aria-current={on ? 'page' : undefined}
                        onClick={() => onSection(s.id)}
                        className={`rounded-md p-1.5 ${on ? 'bg-[var(--bg-2)] text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]'}`}
                    >
                        <Icon name={s.icon} size="sm" />
                    </button>
                );
            })}
        </nav>
    );
}

const CLAIM_START = /^task\.claim-start$/;

/** WIP: reads the page at a lens and story, acts through the board door, and reads again — live on the board's rings. */
export function TynnWipTab({ workspaceId, host }: { workspaceId: string; host: TynnTabHost }) {
    const [query, setQuery] = useState<{ view?: WipLens; story?: string }>({});
    const [state, setState] = useState<TynnPageState<WipView>>({ state: 'loading' });
    const [op, setOp] = useState<BoardOp | null>(null);
    const [lastInput, setLastInput] = useState<BoardActionInput | null>(null);
    const [live, setLive] = useState<LiveState | undefined>(undefined);
    const queryRef = useRef(query);
    queryRef.current = query;
    const read = useCallback(async () => {
        if (!host.page) { setState({ state: 'error', reason: 'This Genie cannot read Tynn\'s WIP page.' }); return; }
        const r = await host.page(workspaceId, 'wip', queryRef.current);
        if (r.ok && r.page === 'wip') { const view = r.view; setState((s) => ({ state: 'ready', view, op: s.state === 'ready' ? s.op ?? null : null })); }
        else if (r.ok) setState({ state: 'error', reason: 'Tynn answered with a different page.' });
        else setState(r.state === 'not-linked' ? { state: 'not-linked' } : r.state === 'signed-out' ? { state: 'signed-out', reason: r.reason } : { state: 'error', reason: r.reason });
    }, [host, workspaceId]);
    useEffect(() => { void read(); }, [read, query]);
    // LIVE: the board's channel and events; each burst of rings is one read of WIP, one at a time (as tynn.ai reloads).
    useEffect(() => {
        const { watch } = host;
        if (!watch) return undefined;
        const follower = new PageFollower({ read, schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } });
        const stop = watch(workspaceId, (signal) => {
            if ('state' in signal) setLive(signal.state);
            else follower.ring();
        });
        return () => { stop(); follower.stop(); setLive(undefined); };
    }, [host, workspaceId, read]);
    const act = async (input: BoardActionInput) => {
        setLastInput(input);
        const r = CLAIM_START.test(input.action)
            ? await performClaimThenStart(host, workspaceId, 'task', input.ids, setOp)
            : await performBoardAction(host, workspaceId, input, setOp);
        if (!r.ok && (r.state === 'not-linked' || r.state === 'signed-out')) {
            setState(r.state === 'not-linked' ? { state: 'not-linked' } : { state: 'signed-out', reason: r.reason });
            return;
        }
        await read();
    };
    const shown: TynnPageState<WipView> = state.state === 'ready' ? { ...state, op } : state;
    return (
        <TynnWipPanel
            state={shown}
            onLens={(lens) => { setOp(null); setQuery({ view: lens }); }}
            onStory={(slug) => { setOp(null); setQuery((q) => ({ ...q, story: slug })); }}
            onAction={(input) => { void act(input); }}
            onRetry={lastInput ? () => { void act(lastInput); } : undefined}
            live={live}
        />
    );
}

/**
 * A page read whole and kept live (`refresh: read`): its state, its read, its live icon, and running an action (a board
 * verb through `act`, a page write through `pageAct`) with progress, then reading it again. WIP has its own copy with
 * its lens and story; the pages without a query (VIP, Releases, …) share this one.
 */
function usePage<V>(workspaceId: string, host: TynnTabHost, page: TynnPage, query: TynnPageQuery, pick: (v: TynnPageView) => V | null) {
    const [state, setState] = useState<TynnPageState<V>>({ state: 'loading' });
    const [op, setOp] = useState<BoardOp | null>(null);
    const [retry, setRetry] = useState<(() => void) | null>(null);
    const [live, setLive] = useState<LiveState | undefined>(undefined);
    const pickRef = useRef(pick);
    pickRef.current = pick;
    const queryRef = useRef(query);
    queryRef.current = query;
    const read = useCallback(async () => {
        if (!host.page) { setState({ state: 'error', reason: 'This Genie cannot read this Tynn page.' }); return; }
        const r = await host.page(workspaceId, page, queryRef.current);
        if (!r.ok) { setState(r.state === 'not-linked' ? { state: 'not-linked' } : r.state === 'signed-out' ? { state: 'signed-out', reason: r.reason } : { state: 'error', reason: r.reason }); return; }
        const view = pickRef.current(r);
        setState(view === null ? { state: 'error', reason: 'Tynn answered with a different page.' } : { state: 'ready', view });
    }, [host, workspaceId, page]);
    // A new query (the Home's section, range or version) is a new read.
    const queryKey = JSON.stringify(query);
    useEffect(() => { void read(); }, [read, queryKey]);
    useEffect(() => {
        const { watch } = host;
        if (!watch) return undefined;
        const follower = new PageFollower({ read, schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } });
        const stop = watch(workspaceId, (signal) => { if ('state' in signal) setLive(signal.state); else follower.ring(); });
        return () => { stop(); follower.stop(); setLive(undefined); };
    }, [host, workspaceId, read]);
    const finish = async (r: { ok: true } | { ok: false; state: string; reason: string }) => {
        if (!r.ok && (r.state === 'not-linked' || r.state === 'signed-out')) {
            setState(r.state === 'not-linked' ? { state: 'not-linked' } : { state: 'signed-out', reason: r.reason });
            return;
        }
        await read();
    };
    const act = async (input: BoardActionInput) => {
        setRetry(() => () => { void act(input); });
        await finish(await performBoardAction(host, workspaceId, input, setOp));
    };
    const pageAct = async (input: TynnPageActionInput) => {
        setRetry(() => () => { void pageAct(input); });
        const run = host.pageAct;
        if (!run) { setOp({ action: input.action, phase: 'failed', reason: 'This Genie cannot do that on Tynn.' }); return; }
        await finish(await performBoardAction({ act: (id) => run(id, input) }, workspaceId, { action: input.action, ids: {} }, setOp));
    };
    const shown: TynnPageState<V> = state.state === 'ready' ? { ...state, op } : state;
    return { state: shown, act, pageAct, retry, live };
}

/** VIP: the lane, Start VIP, each story's move and the Release — live on the board's rings. */
export function TynnVipTab({ workspaceId, host }: { workspaceId: string; host: TynnTabHost }) {
    const p = usePage<VipView>(workspaceId, host, 'vip', NO_QUERY, (r) => (r.page === 'vip' ? r.view : null));
    return <TynnVipPanel state={p.state} onAction={(i) => { void p.act(i); }} onStart={(i) => { void p.pageAct(i); }} onRetry={p.retry ?? undefined} live={p.live} />;
}

const NO_QUERY: TynnPageQuery = {};

/** Home: Dashboard or Details, the range and the version as its query; Details saves through its own door. */
export function TynnHomeTab({ workspaceId, host }: { workspaceId: string; host: TynnTabHost }) {
    const [query, setQuery] = useState<TynnPageQuery>({});
    const p = usePage<HomeView>(workspaceId, host, 'home', query, (r) => (r.page === 'home' ? r.view : null));
    return <TynnHomePanel state={p.state} onQuery={setQuery} onSave={(i) => { void p.pageAct(i); }} onRetry={p.retry ?? undefined} live={p.live} />;
}

/** Releases: read only, live on the board's rings. */
export function TynnReleasesTab({ workspaceId, host }: { workspaceId: string; host: TynnTabHost }) {
    const p = usePage<ReleasesView>(workspaceId, host, 'releases', NO_QUERY, (r) => (r.page === 'releases' ? r.view : null));
    return <TynnReleasesPanel state={p.state} live={p.live} />;
}

/** The tab: the page nav, and the page that is open. */
export function TynnTab({ workspaceId, host }: { workspaceId: string; host: TynnTabHost }) {
    const [section, setSection] = useState<TynnSectionId>(host.page ? TYNN_FIRST_SECTION : 'board');
    // A page this host cannot read is not offered; the board always is.
    return (
        <div data-tynn-tab="" className="flex min-h-0 min-w-0 flex-1 flex-col">
            {host.page ? <TynnSectionNav current={section} onSection={setSection} /> : null}
            <div className="flex min-h-0 min-w-0 flex-1 overflow-auto">
                {section === 'home' && host.page ? <TynnHomeTab workspaceId={workspaceId} host={host} />
                    : section === 'wip' && host.page ? <TynnWipTab workspaceId={workspaceId} host={host} />
                    : section === 'vip' && host.page ? <TynnVipTab workspaceId={workspaceId} host={host} />
                    : section === 'releases' && host.page ? <TynnReleasesTab workspaceId={workspaceId} host={host} />
                        : <TynnBoardTab workspaceId={workspaceId} host={host} />}
            </div>
        </div>
    );
}
