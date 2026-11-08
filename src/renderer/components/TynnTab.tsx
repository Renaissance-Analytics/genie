import { Icon, Sidebar } from '@particle-academy/react-fancy';
import { useCallback, useEffect, useRef, useState } from 'react';
import { performBoardAction, performClaimThenStart, type BoardActionInput, type BoardOp, type LiveState } from '../../core/tynn-board.js';
import { PageFollower, TYNN_FIRST_SECTION, TYNN_SECTIONS, type HomeView, type ReleasesView, type TynnPageActionInput, type TynnPageQuery, type TynnPageState, type TynnSectionId, type TynnTabHost, type WipLens, type WipView } from '../../core/tynn-pages.js';
import { TynnBoardTab } from './TynnBoardPanel.js';
import { TynnHomePanel } from './TynnHomePanel.js';
import { TynnReleasesPanel } from './TynnReleasesPanel.js';
import { TynnWipPanel } from './TynnWipPanel.js';
import { TynnIssuesTab } from './TynnIssuesPanel.js';
import type { TynnIssuesHost } from '../../core/tynn-issues.js';

/**
 * THE TYNN TAB (genie#1295): tynn.ai's workspace for the workspace's own project — its pages in tynn.ai's order with
 * tynn.ai's icons, and no user menu or project picker (the owner: "full parity … minus the user and project menus").
 * The board keeps its own tab component (TynnBoardPanel.tsx); each other page has its own panel, read through the host's
 * `page` door. A page joins the nav (core/tynn-pages.ts TYNN_SECTIONS) when it is built.
 */

/** The page nav: an icon per page, named for a screen reader (the owner: icons over words). */
export function TynnSectionNav({ current, onSection, offered }: { current: TynnSectionId; onSection: (id: TynnSectionId) => void; offered?: readonly TynnSectionId[] }) {
    return (
        <Sidebar embedded collapsed className="w-auto shrink-0 border-b border-[var(--border-1)]">
            <nav aria-label="Tynn" className="flex items-center gap-0.5 px-2 py-1">
                {TYNN_SECTIONS.filter((s) => offered === undefined || offered.includes(s.id)).map((s) => {
                    const on = s.id === current;
                    return (
                        <Sidebar.Item
                            key={s.id}
                            data-tynn-section={s.id}
                            aria-label={s.label}
                            active={on}
                            icon={<Icon name={s.icon} size="sm" />}
                            onClick={() => onSection(s.id)}
                            className={`size-8 shrink-0 rounded-md p-1.5 ${on ? 'bg-[var(--bg-2)] text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]'}`}
                        >
                            {s.label}
                        </Sidebar.Item>
                    );
                })}
            </nav>
        </Sidebar>
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
        if (r.ok && r.page === 'wip') setState((s) => ({ state: 'ready', view: r.view, op: s.state === 'ready' ? s.op ?? null : null }));
        else if (r.ok) setState({ state: 'error', reason: 'Tynn answered with a different workspace page.' });
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

/** Releases: read only, through the host's page door, live on the board's rings (one read per burst). */
/**
 * Home: Dashboard or Details, with the range and version as its query, read through the host's page door and live on the
 * board's rings (one read per burst). A Details save says running, then saved (the view becomes Tynn's answer), or Tynn's
 * reason with Retry.
 */
export function TynnHomeTab({ workspaceId, host }: { workspaceId: string; host: TynnTabHost }) {
    const [query, setQuery] = useState<TynnPageQuery>({});
    const [state, setState] = useState<TynnPageState<HomeView>>({ state: 'loading' });
    const [op, setOp] = useState<BoardOp | null>(null);
    const [lastInput, setLastInput] = useState<TynnPageActionInput | null>(null);
    const [live, setLive] = useState<LiveState | undefined>(undefined);
    const queryRef = useRef(query);
    queryRef.current = query;
    const read = useCallback(async () => {
        if (!host.page) { setState({ state: 'error', reason: 'This Genie cannot read Tynn\'s Home.' }); return; }
        const r = await host.page(workspaceId, 'home', queryRef.current);
        if (r.ok && r.page === 'home') setState({ state: 'ready', view: r.view });
        else if (r.ok) setState({ state: 'error', reason: 'Tynn answered with a different workspace page.' });
        else setState(r.state === 'not-linked' ? { state: 'not-linked' } : r.state === 'signed-out' ? { state: 'signed-out', reason: r.reason } : { state: 'error', reason: r.reason });
    }, [host, workspaceId]);
    useEffect(() => { void read(); }, [read, query]);
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
    const save = async (input: TynnPageActionInput) => {
        setLastInput(input);
        if (!host.pageAct) { setOp({ action: input.action, phase: 'failed', reason: 'This Genie cannot save to Tynn here.' }); return; }
        setOp({ action: input.action, phase: 'running' });
        const r = await host.pageAct(workspaceId, input);
        if (r.ok && r.page === 'home') {
            setState({ state: 'ready', view: r.view });
            setOp({ action: input.action, phase: 'done' });
        } else if (r.ok) setOp({ action: input.action, phase: 'failed', reason: 'Tynn answered with a different workspace page.' });
        else if (r.state === 'not-linked' || r.state === 'signed-out') { setOp(null); setState(r.state === 'not-linked' ? { state: 'not-linked' } : { state: 'signed-out', reason: r.reason }); }
        else setOp({ action: input.action, phase: 'failed', reason: r.reason });
    };
    const shown: TynnPageState<HomeView> = state.state === 'ready' ? { ...state, op } : state;
    return (
        <TynnHomePanel
            state={shown}
            onQuery={(q) => { setOp(null); setQuery(q); }}
            onSave={(input) => { void save(input); }}
            onRetry={lastInput ? () => { void save(lastInput); } : undefined}
            live={live}
        />
    );
}

export function TynnReleasesTab({ workspaceId, host }: { workspaceId: string; host: TynnTabHost }) {
    const [state, setState] = useState<TynnPageState<ReleasesView>>({ state: 'loading' });
    const [live, setLive] = useState<LiveState | undefined>(undefined);
    const read = useCallback(async () => {
        if (!host.page) { setState({ state: 'error', reason: 'This Genie cannot read Tynn\'s Releases page.' }); return; }
        const r = await host.page(workspaceId, 'releases', {});
        if (r.ok && r.page === 'releases') setState({ state: 'ready', view: r.view });
        else if (r.ok) setState({ state: 'error', reason: 'Tynn answered with a different workspace page.' });
        else setState(r.state === 'not-linked' ? { state: 'not-linked' } : r.state === 'signed-out' ? { state: 'signed-out', reason: r.reason } : { state: 'error', reason: r.reason });
    }, [host, workspaceId]);
    useEffect(() => { void read(); }, [read]);
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
    return <TynnReleasesPanel state={state} live={live} />;
}

/** The tab: the page nav, and the page that is open. */
export function TynnTab({ workspaceId, host, issues, initialSection }: { workspaceId: string; host: TynnTabHost; issues?: TynnIssuesHost | undefined; initialSection?: TynnSectionId }) {
    // The tab opens on Home, as tynn.ai's project does; a window with no page door opens on the board.
    const [section, setSection] = useState<TynnSectionId>(initialSection ?? (host.page ? TYNN_FIRST_SECTION : 'board'));
    // A page this host cannot read is not offered; the board always is. Issues has its own door (row I1).
    const offered = TYNN_SECTIONS.map((s) => s.id).filter((id) => id === 'board' || (id === 'issues' ? issues !== undefined : host.page !== undefined));
    return (
        <div data-tynn-tab="" className="flex min-h-0 min-w-0 flex-1 flex-col">
            {offered.length > 1 ? <TynnSectionNav current={section} onSection={setSection} offered={offered} /> : null}
            <div className="flex min-h-0 min-w-0 flex-1 overflow-auto">
                {section === 'issues' && issues ? <TynnIssuesTab workspaceId={workspaceId} host={issues} />
                    : section === 'wip' && host.page ? <TynnWipTab workspaceId={workspaceId} host={host} />
                    : section === 'releases' && host.page ? <TynnReleasesTab workspaceId={workspaceId} host={host} />
                    : section === 'home' && host.page ? <TynnHomeTab workspaceId={workspaceId} host={host} />
                        : <TynnBoardTab workspaceId={workspaceId} host={host} />}
            </div>
        </div>
    );
}
