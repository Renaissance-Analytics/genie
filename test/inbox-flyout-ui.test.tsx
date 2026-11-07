import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Drawer } from '@particle-academy/react-fancy';
import { inboxThreads, pairKey, type ThreadMail } from '../src/core/inbox-threads.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { InboxFlyoutView, inboxTarget, type InboxFlyoutViewProps } from '../src/renderer/components/InboxFlyout.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { EMPTY_FEATURES, type FeatureData, type InboxThreadView } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * THE AGENTINBOX FLYOUT (beta.33 item 19). The owner: "The genie 2 AgentInbox UX is still nothing like genie 1's which was
 * not perfect but it was much better … the agentinbox should not be a page and it should be accessible from the header
 * system icons just like it was in genie 1."
 *
 * Genie 1's flyout from its code (review-g1 `renderer/components/Master/AgentInboxFlyout.tsx`), held here: two panes —
 * threads (search, All / Unread / Stale, newest first) and the open thread; the person's own thread with a composer and
 * attachments; agent-to-agent threads read-only ("You're observing") with a way to message either agent; attachment
 * download; who is waiting on mail; Delete thread. Plus what Genie 1 lacked: Load older, Mark all read, New message.
 */
const T = Date.UTC(2026, 9, 20, 12, 0, 0);
let seq = 0;
const m = (from: string, to: string, text: string, at: number, readAt: string | null = null, attachments: ThreadMail['attachments'] = []): ThreadMail =>
    ({ seq: ++seq, id: `msg_${seq}`, from, to, text, attachments, sentAt: new Date(at).toISOString(), readAt });
const names: Record<string, string> = { human: 'you', agent_atlas: 'atlas', agent_wren: 'wren' };
const mail = [
    m('human', 'agent_atlas', 'Ship the cache driver?', T - 600_000, new Date(T - 500_000).toISOString()),
    m('agent_atlas', 'human', 'Shipped — **diff attached**', T - 300_000, null, [{ id: 'att_1', name: 'diff.patch', size: 2048 }]),
    m('agent_atlas', 'agent_wren', 'drop the challenges table', T - 60_000, null),
];
const threads = inboxThreads(mail, (p) => names[p] ?? p);
const peers = [
    { address: 'tynn:claude:atlas', agentId: 'agent_atlas', name: 'atlas', reachable: true },
    { address: 'tynn:claude:wren', agentId: 'agent_wren', name: 'wren', reachable: true },
    { address: 'tynn:codex:gone', name: 'gone', reachable: false },
];
const humanKey = pairKey('human', 'agent_atlas');
const agentsKey = pairKey('agent_atlas', 'agent_wren');
const thread = (key: string, over: Partial<InboxThreadView> = {}): InboxThreadView =>
    ({ key, messages: mail.filter((x) => pairKey(x.from, x.to) === key) as never, more: false, limit: 50, focus: null, ...over });

const noop = () => {};
/** A string as a literal inside a RegExp. */
const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const props = (over: Partial<InboxFlyoutViewProps> = {}): InboxFlyoutViewProps => ({
    threads, peers, thread: null, openKey: null, query: '', filter: 'all', now: T, uncollected: 1, unread: 1, draft: '',
    onQuery: noop, onFilter: noop, onOpenThread: noop, onLoadOlder: noop, onDraft: noop, onSend: noop, onDownload: noop, onMarkAllRead: noop, onDelete: noop, onClose: noop,
    ...over,
});
const html = (p: InboxFlyoutViewProps) => renderToStaticMarkup(<Drawer open onClose={noop} attach="container"><InboxFlyoutView {...p} /></Drawer>);

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const p = node.props as Props;
    if (match(p)) out.push(p);
    findAll(p.children, match, out);
    return out;
}

describe('the header’s system icon', () => {
    const bar = (inbox?: Parameters<typeof TitleBar>[0]['inbox']) =>
        renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={null} onNavigate={noop} onOpenPalette={noop} platform="generic" {...(inbox ? { inbox } : {})} />);

    it('an AgentInbox icon among the feature icons, with the person’s unread count on it, pressed while open', () => {
        expect(bar({ unread: 3, open: false, onToggle: noop })).toMatch(/data-system-icon="AgentInbox"[^>]*data-inbox-icon="closed"[\s\S]*data-inbox-badge="3"/);
        const open = bar({ unread: 3, open: true, onToggle: noop });
        expect(open).toContain('data-inbox-icon="open"');
        expect(open).toContain('aria-pressed="true"');
    });

    it('no unread (0) or not read yet (null) draws no count — never a 0; no inbox wired, no icon', () => {
        expect(bar({ unread: 0, open: false, onToggle: noop })).not.toContain('data-inbox-badge');
        expect(bar({ unread: null, open: false, onToggle: noop })).not.toContain('data-inbox-badge');
        expect(bar({ unread: null, open: false, onToggle: noop })).toContain('data-system-icon="AgentInbox"');
        expect(bar()).not.toContain('data-system-icon="AgentInbox"');
    });
});

describe('the flyout in the shell', () => {
    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, workspaces: [{ id: 'ws', path: '/w/tynn', name: 'tynn', agentsKnown: true }] };
    const features: FeatureData = { ...EMPTY_FEATURES, inbox: { unread: [mail[1]] as never, peers, recent: [], threads, uncollected: 1 } };
    const shell = (route: string, withAsk = true) => renderToStaticMarkup(
        <Shell
            route={route} snapshot={snapshot} servable={['dashboard', 'deck', 'agent', 'workspace', 'settings']}
            agentDetail={null} agentResolved={false} selectedRowId={null} chatThread={null} pinned={null} files={NO_FILES}
            features={features}
            {...(withAsk ? { featureAsk: async () => features } : {})}
            onNavigate={noop} onOpenAgent={noop} onAddAgent={noop} onAddWorkspace={noop} onOpenPalette={noop} onSelectRow={noop}
            onSend={noop} onToggleFilesPin={noop} onCloseChat={noop} answeringApproval={null} onAnswerApproval={noop} onAnswerDeckItem={noop} onFeature={noop}
        />,
    );

    it('`inbox=` opens it over the page, with its threads — the page stays under it (positive control: without it, closed)', () => {
        const open = shell('genie://dashboard?group=workspace&inbox=');
        expect(open).toContain('data-inbox-flyout');
        expect(open).toContain(`data-inbox-thread="${humanKey}"`);
        expect(open).toContain(`data-inbox-thread="${agentsKey}"`);
        expect(open).toContain('data-inbox-icon="open"');
        const closed = shell('genie://dashboard?group=workspace');
        expect(closed).not.toContain('data-inbox-flyout');
        expect(closed).toContain('data-inbox-icon="closed"');
        expect(closed).toContain('data-inbox-badge="1"');
    });

    it('no AgentInbox wired in this window: no icon and no flyout', () => {
        const html = shell('genie://dashboard?group=workspace&inbox=', false);
        expect(html).not.toContain('data-system-icon="AgentInbox"');
        expect(html).not.toContain('data-inbox-flyout');
    });
});

describe('the threads pane', () => {
    it('each thread: who, the last line, unread and waiting — agent-to-agent marked read-only; newest first', () => {
        const out = html(props());
        expect(out.indexOf(`data-inbox-thread="${agentsKey}"`)).toBeLessThan(out.indexOf(`data-inbox-thread="${humanKey}"`));
        expect(out).toMatch(new RegExp(`data-inbox-thread="${esc(humanKey)}"[\\s\\S]*?atlas[\\s\\S]*?atlas: Shipped — \\*\\*diff attached\\*\\*[\\s\\S]*?data-thread-unread="1"`));
        expect(out).toMatch(/atlas ⇄ wren[\s\S]*?waiting on wren · 1m/);
        expect(out).toContain('data-inbox-unread="1"');
        expect(out).toContain('data-inbox-uncollected="1"');
    });

    it('the filters carry their counts; a press filters; search narrows by any message', () => {
        const out = html(props());
        expect(out).toMatch(/data-inbox-filter="all"[^>]*>(?:<[^>]*>)*All 2</);
        expect(out).toMatch(/data-inbox-filter="unread"[^>]*>(?:<[^>]*>)*Unread 1</);
        expect(out).toMatch(/data-inbox-filter="waiting"[^>]*>(?:<[^>]*>)*Waiting 1</);
        const picked: string[] = [];
        for (const b of findAll(InboxFlyoutView(props({ onFilter: (f) => picked.push(f) })), (p) => p['data-inbox-filter'] !== undefined)) (b.onClick as () => void)();
        expect(picked).toEqual(['all', 'unread', 'waiting', 'stale']);
        // "cache driver" is only in the FIRST message of atlas's thread.
        const searched = html(props({ query: 'cache driver' }));
        expect(searched).toContain(`data-inbox-thread="${humanKey}"`);
        expect(searched).not.toContain(`data-inbox-thread="${agentsKey}"`);
    });

    it('New message offers the reachable agents only, and opens the person’s thread with the one picked', () => {
        const opened: (string | null)[] = [];
        const [select] = findAll(InboxFlyoutView(props({ onOpenThread: (k) => opened.push(k) })), (p) => p['data-inbox-new'] !== undefined);
        expect((select!.list as { value: string }[]).map((o) => o.value)).toEqual(['agent_atlas', 'agent_wren']);
        (select!.onValueChange as (v: string) => void)('agent_wren');
        expect(opened).toEqual([pairKey('human', 'agent_wren')]);
    });

    it('a press on a thread opens it', () => {
        const opened: (string | null)[] = [];
        const rows = findAll(InboxFlyoutView(props({ onOpenThread: (k) => opened.push(k) })), (p) => p['data-inbox-thread'] !== undefined);
        for (const r of rows) (r.onClick as () => void)();
        expect(opened).toEqual([agentsKey, humanKey]);
    });
});

describe('the open thread', () => {
    it('the person’s thread: each message rendered, its attachments by name and size (a press downloads), and a composer', () => {
        const out = html(props({ openKey: humanKey, thread: thread(humanKey) }));
        expect(out).toContain('Your direct thread');
        // Newest on top by default (the owner, 2026-11-01).
        expect(out).toMatch(/atlas → you[\s\S]*<strong>diff attached<\/strong>[\s\S]*you → atlas[\s\S]*Ship the cache driver\?/);
        expect(out).toMatch(/data-inbox-attachment="att_1"[\s\S]*diff\.patch · 2\.0 kB/);
        expect(out).toContain('data-inbox-composer');
        expect(out).not.toContain('data-inbox-readonly');
        const got: string[][] = [];
        const [att] = findAll(InboxFlyoutView(props({ openKey: humanKey, thread: thread(humanKey), onDownload: (id, name) => got.push([id, name]) })), (p) => p['data-inbox-attachment'] !== undefined);
        (att!.onClick as () => void)();
        expect(got).toEqual([['att_1', 'diff.patch']]);
    });

    it('the composer attaches host files (removable) when a picker is wired, and sends; Send waits for words', () => {
        const compose = { attachments: ['/w/tynn/notes.md'], onPick: noop, onRemove: noop };
        const out = html(props({ openKey: humanKey, thread: thread(humanKey), compose, draft: 'go' }));
        expect(out).toContain('data-action="attach-files"');
        expect(out).toContain('data-attached="notes.md"');
        expect(out).toMatch(/data-action="inbox-send"(?![^>]*disabled)/);
        expect(html(props({ openKey: humanKey, thread: thread(humanKey), draft: '  ' }))).toMatch(/<button[^>]*disabled=""[^>]*data-action="inbox-send"|data-action="inbox-send"[^>]*disabled=""/);
        expect(html(props({ openKey: humanKey, thread: thread(humanKey) }))).not.toContain('data-action="attach-files"');
    });

    it('an agent-to-agent thread is read-only — you are observing — with a way to message either agent; no composer', () => {
        const out = html(props({ openKey: agentsKey, thread: thread(agentsKey) }));
        expect(out).toContain('data-inbox-readonly');
        expect(out).toContain('You are observing');
        expect(out).not.toContain('data-inbox-composer');
        expect(out).toContain('not collected yet');
        const opened: (string | null)[] = [];
        for (const b of findAll(InboxFlyoutView(props({ openKey: agentsKey, thread: thread(agentsKey), onOpenThread: (k) => opened.push(k) })), (p) => p['data-action'] === 'inbox-message-agent')) (b.onClick as () => void)();
        expect(opened).toEqual([pairKey('human', 'agent_atlas'), pairKey('human', 'agent_wren')]);
    });

    it('older messages page back (`Load older` only when there are more); the message it was opened on is marked', () => {
        expect(html(props({ openKey: humanKey, thread: thread(humanKey, { more: true }) }))).toContain('data-action="inbox-load-older"');
        expect(html(props({ openKey: humanKey, thread: thread(humanKey) }))).not.toContain('data-action="inbox-load-older"');
        expect(html(props({ openKey: humanKey, thread: thread(humanKey, { focus: 'msg_2' }) }))).toMatch(/data-inbox-message="msg_2" data-focus="true"/);
    });

    it('Delete thread and Mark all read reach their actions', () => {
        const did: string[] = [];
        const tree = InboxFlyoutView(props({ openKey: humanKey, thread: thread(humanKey), onDelete: (k) => did.push(`delete ${k}`), onMarkAllRead: () => did.push('read all') }));
        for (const b of findAll(tree, (p) => p['data-action'] === 'inbox-delete-thread' || p['data-action'] === 'inbox-mark-all-read')) (b.onClick as () => void)();
        expect(did.sort()).toEqual([`delete ${humanKey}`, 'read all']);
    });
});

describe('the route value', () => {
    it('`` = the threads; `msg_…` = a message; anything else = a thread key', () => {
        expect(inboxTarget('')).toEqual({ kind: 'list' });
        expect(inboxTarget('msg_12')).toEqual({ kind: 'message', id: 'msg_12' });
        expect(inboxTarget(humanKey)).toEqual({ kind: 'thread', key: humanKey });
    });
});

/**
 * SORT, SEARCH AND THE FTQ EXPAND (the owner, 2026-11-01: "msgs in the inbox should be sortable and searchable, sort newest
 * on top by default." and "for FTQ responses in the inbox, the id should be a link that expands to show the questions
 * asked."). Icons over words; every control a react-fancy Button; every action shows it is running, then the result or
 * the failure with Retry.
 */
const order = (out: string): string[] => [...out.matchAll(/data-inbox-message="([^"]+)"/g)].map((x) => x[1]!);
const QID = 'q_e07a0573-1b2c-4d5e-8f90-123456789abc';
const answerMail = { seq: 900, id: 'msg_900', from: 'human', to: 'agent_atlas', text: `Answer to your question ${QID}:\n- **Deploy** — Ship now?\n  → Yes`, attachments: [], sentAt: new Date(T - 10_000).toISOString(), readAt: null };
const record = {
    id: QID, agentName: 'atlas', askedAt: new Date(T - 20_000).toISOString(), at: new Date(T - 10_000).toISOString(), outcome: 'answered' as const,
    questions: [
        { header: 'Deploy', question: 'Ship **now**?', options: [{ label: 'Yes', description: 'Deploy at once' }, { label: 'No', description: 'Wait for Monday' }] },
        { header: 'Notify', question: 'Who hears?', multiSelect: true, options: [{ label: 'Team' }, { label: 'Owner', description: 'Only the owner' }, { label: 'Nobody' }] },
    ],
    selections: [['Yes'], ['Team', 'Owner']], notes: ['', 'cc me'], note: 'thanks',
};
const ftqThread = (): InboxThreadView => ({ key: humanKey, messages: [answerMail] as never, more: false, limit: 50, focus: null });

describe('the open thread’s order', () => {
    it('newest on top by DEFAULT (positive control: the same thread oldest-first is the other way round)', () => {
        expect(order(html(props({ openKey: humanKey, thread: thread(humanKey) })))).toEqual(['msg_2', 'msg_1']);
        expect(order(html(props({ openKey: humanKey, thread: thread(humanKey), order: 'oldest' })))).toEqual(['msg_1', 'msg_2']);
    });

    it('one icon button toggles it — pressed, it asks for the other order; its name says what it shows', () => {
        const asked: string[] = [];
        const [btn] = findAll(InboxFlyoutView(props({ openKey: humanKey, thread: thread(humanKey), onOrder: (o) => asked.push(o) })), (p) => p['data-action'] === 'inbox-sort');
        expect(btn!['data-order']).toBe('newest');
        expect(btn!.icon).toBe('arrow-down-wide-narrow');
        expect(btn!['aria-label']).toBe('Newest first');
        expect(btn!.children ?? null).toBeNull();
        (btn!.onClick as () => void)();
        const [back] = findAll(InboxFlyoutView(props({ openKey: humanKey, thread: thread(humanKey), order: 'oldest', onOrder: (o) => asked.push(o) })), (p) => p['data-action'] === 'inbox-sort');
        expect(back!.icon).toBe('arrow-up-narrow-wide');
        (back!.onClick as () => void)();
        expect(asked).toEqual(['oldest', 'newest']);
    });

    it('Load older follows the order: at the END newest-first, at the TOP oldest-first; spins while it loads', () => {
        const newest = html(props({ openKey: humanKey, thread: thread(humanKey, { more: true }) }));
        expect(newest.indexOf('data-action="inbox-load-older"')).toBeGreaterThan(newest.lastIndexOf('data-inbox-message='));
        const oldest = html(props({ openKey: humanKey, thread: thread(humanKey, { more: true }), order: 'oldest' }));
        expect(oldest.indexOf('data-action="inbox-load-older"')).toBeLessThan(oldest.indexOf('data-inbox-message='));
        expect(html(props({ openKey: humanKey, thread: thread(humanKey, { more: true }), loadingOlder: true }))).toMatch(/data-action="inbox-load-older"[^>]*disabled|disabled[^>]*data-action="inbox-load-older"/);
    });

    it('a trimmed buffer (the newest end dropped after paging far back) offers a way back to the newest', () => {
        const back: number[] = [];
        expect(html(props({ openKey: humanKey, thread: thread(humanKey) }))).not.toContain('data-action="inbox-back-to-newest"');
        const [btn] = findAll(InboxFlyoutView(props({ openKey: humanKey, thread: thread(humanKey, { newer: true }), onBackToNewest: () => back.push(1) })), (p) => p['data-action'] === 'inbox-back-to-newest');
        (btn!.onClick as () => void)();
        expect(back).toEqual([1]);
    });
});

describe('searching the open thread', () => {
    it('a search field on the thread; typing asks for a search', () => {
        const q: string[] = [];
        const [field] = findAll(InboxFlyoutView(props({ openKey: humanKey, thread: thread(humanKey), onThreadQuery: (v) => q.push(v) })), (p) => p['data-inbox-thread-search'] !== undefined);
        (field!.onValueChange as (v: string) => void)('cache');
        expect(q).toEqual(['cache']);
    });

    it('while it runs: visible progress, and the thread’s own messages are not passed off as results', () => {
        const out = html(props({ openKey: humanKey, thread: thread(humanKey), threadQuery: 'cache', search: { query: 'cache', status: 'searching', hits: [], total: 0, error: null } }));
        expect(out).toContain('data-inbox-searching');
        expect(order(out)).toEqual([]);
    });

    it('hits: each with the match marked, the count, newest first; a press jumps to it in the thread', () => {
        const hits = mail.slice(0, 2).reverse() as never;
        const p = props({ openKey: humanKey, thread: thread(humanKey), threadQuery: 'ship', search: { query: 'ship', status: 'done', hits, total: 2, error: null } });
        const out = html(p);
        expect(out).toMatch(/data-inbox-search-count="2"/);
        expect(out).toMatch(/<mark[^>]*data-search-hit=""[^>]*>Ship<\/mark>/);
        expect([...out.matchAll(/data-inbox-search-hit="([^"]+)"/g)].map((x) => x[1])).toEqual(['msg_2', 'msg_1']);
        const jumped: string[] = [];
        const [first] = findAll(InboxFlyoutView({ ...p, onJump: (h) => jumped.push(h.id) }), (x) => x['data-inbox-search-hit'] !== undefined);
        (first!.onClick as () => void)();
        expect(jumped).toEqual(['msg_2']);
    });

    it('no hits says so; a failure says why, with Retry', () => {
        expect(html(props({ openKey: humanKey, thread: thread(humanKey), threadQuery: 'zzz', search: { query: 'zzz', status: 'done', hits: [], total: 0, error: null } }))).toContain('data-inbox-no-matches');
        const retried: number[] = [];
        const p = props({ openKey: humanKey, thread: thread(humanKey), threadQuery: 'x', search: { query: 'x', status: 'error', hits: [], total: 0, error: 'host gone' }, onRetrySearch: () => retried.push(1) });
        expect(html(p)).toMatch(/data-inbox-search-error[\s\S]*host gone/);
        for (const b of findAll(InboxFlyoutView(p), (x) => x['data-action'] === 'inbox-search-retry')) (b.onClick as () => void)();
        expect(retried).toEqual([1]);
    });
});

describe('an FTQ answer’s question id', () => {
    it('is a link Button, shortened, the full id on hover; the "Answer to…" line is not repeated under it', () => {
        const toggled: string[] = [];
        const p = props({ openKey: humanKey, thread: ftqThread(), onToggleQuestion: (id) => toggled.push(id) });
        const out = html(p);
        expect(out).toMatch(/<a[^>]*data-question-ref="q_e07a0573-1b2c-4d5e-8f90-123456789abc"/);
        expect(out).toContain('q_e07a0573…');
        expect(out).toMatch(new RegExp(`title="${esc(QID)}"`));
        expect(out).toContain('aria-expanded="false"');
        expect(out).not.toContain('Answer to your question');
        const [ref] = findAll(InboxFlyoutView(p), (x) => x['data-question-ref'] !== undefined);
        let prevented = false;
        (ref!.onClick as (e: { preventDefault: () => void }) => void)({ preventDefault: () => { prevented = true; } });
        expect([toggled, prevented]).toEqual([[QID], true]);
    });

    it('expanded: every question with ALL its options and descriptions, the chosen ones marked, the notes shown', () => {
        const out = html(props({ openKey: humanKey, thread: ftqThread(), expandedQuestions: [QID], questions: { [QID]: { status: 'ok', record } } }));
        expect(out).toContain('aria-expanded="true"');
        expect(out).toMatch(/data-question-panel="q_e07a0573[^"]*"/);
        for (const text of ['Deploy', 'Notify', 'Who hears?', 'Deploy at once', 'Wait for Monday', 'Only the owner', 'cc me', 'thanks']) expect(out).toContain(text);
        expect(out).toContain('<strong>now</strong>');
        const chosen = [...out.matchAll(/data-option="([^"]+)" data-chosen="(true|false)"/g)].map((x) => `${x[1]}:${x[2]}`);
        expect(chosen).toEqual(['Yes:true', 'No:false', 'Team:true', 'Owner:true', 'Nobody:false']);
    });

    it('collapsed again: no panel (positive control above)', () => {
        expect(html(props({ openKey: humanKey, thread: ftqThread(), questions: { [QID]: { status: 'ok', record } } }))).not.toContain('data-question-panel');
    });

    it('loading shows progress; a record that is gone is said plainly; a failure has Retry', () => {
        expect(html(props({ openKey: humanKey, thread: ftqThread(), expandedQuestions: [QID], questions: { [QID]: { status: 'loading' } } }))).toContain('data-question-loading');
        expect(html(props({ openKey: humanKey, thread: ftqThread(), expandedQuestions: [QID], questions: { [QID]: { status: 'gone' } } }))).toMatch(/data-question-gone[\s\S]*no longer kept/);
        const retried: string[] = [];
        const p = props({ openKey: humanKey, thread: ftqThread(), expandedQuestions: [QID], questions: { [QID]: { status: 'error', error: 'host gone' } }, onRetryQuestion: (id) => retried.push(id) });
        expect(html(p)).toMatch(/data-question-error[\s\S]*host gone/);
        for (const b of findAll(InboxFlyoutView(p), (x) => x['data-action'] === 'inbox-question-retry')) (b.onClick as () => void)();
        expect(retried).toEqual([QID]);
    });
});
