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
        expect(bar({ unread: 3, open: false, onToggle: noop })).toMatch(/data-feature="AgentInbox"[^>]*data-inbox-icon="closed"[\s\S]*data-inbox-badge="3"/);
        const open = bar({ unread: 3, open: true, onToggle: noop });
        expect(open).toContain('data-inbox-icon="open"');
        expect(open).toContain('aria-pressed="true"');
    });

    it('no unread (0) or not read yet (null) draws no count — never a 0; no inbox wired, no icon', () => {
        expect(bar({ unread: 0, open: false, onToggle: noop })).not.toContain('data-inbox-badge');
        expect(bar({ unread: null, open: false, onToggle: noop })).not.toContain('data-inbox-badge');
        expect(bar({ unread: null, open: false, onToggle: noop })).toContain('data-feature="AgentInbox"');
        expect(bar()).not.toContain('data-feature="AgentInbox"');
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
        expect(html).not.toContain('data-feature="AgentInbox"');
        expect(html).not.toContain('data-inbox-flyout');
    });
});

describe('the threads pane', () => {
    it('each thread: who, the last line, unread and waiting — agent-to-agent marked read-only; newest first', () => {
        const out = html(props());
        expect(out.indexOf(`data-inbox-thread="${agentsKey}"`)).toBeLessThan(out.indexOf(`data-inbox-thread="${humanKey}"`));
        expect(out).toMatch(new RegExp(`data-inbox-thread="${humanKey.replace('|', '\\|')}"[\\s\\S]*?atlas[\\s\\S]*?atlas: Shipped — \\*\\*diff attached\\*\\*[\\s\\S]*?data-thread-unread="1"`));
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
        expect(out).toMatch(/you → atlas[\s\S]*Ship the cache driver\?[\s\S]*atlas → you[\s\S]*<strong>diff attached<\/strong>/);
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
