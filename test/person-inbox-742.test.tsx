// @vitest-environment happy-dom
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairKey, type ThreadMail } from '../src/core/inbox-threads.js';
import { isPersonInbox, PERSON_INBOX, PERSON_INBOX_MAX, personItems, personUnread, type PersonItem } from '../src/core/person-inbox.js';
import type { RailItem } from '../src/core/rail-view.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { PersonInbox, PersonInboxView, type PersonInboxViewProps } from '../src/renderer/components/PersonInbox.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * THE PERSON'S INBOX (Tynn #742). A client onboarding call, 2026-11-16: the client was sent to the AgentInbox to read an item
 * an agent had left for them, and it was lost among the agents' mail to each other. The owner: "There's going to be a user
 * inbox that's coming, on the left-hand side, so things that are specific to you [are separate]".
 *
 * Held here: only mail addressed TO the person (an agent's, an app's) — never agent-to-agent mail, never what the person
 * sent; one click from the rail, with the unread count; an item opens in place, is marked read, and Reply goes to its
 * conversation in the AgentInbox. The AgentInbox itself is unchanged (CONTROL).
 */
const T = Date.UTC(2026, 10, 17, 12, 0, 0);
let seq = 0;
const m = (from: string, to: string, text: string, at: number, readAt: string | null = null, over: Partial<ThreadMail> = {}): ThreadMail =>
    ({ seq: ++seq, id: `msg_${seq}`, from, to, text, attachments: [], sentAt: new Date(at).toISOString(), readAt, ...over });
const names: Record<string, string> = { human: 'you', agent_atlas: 'atlas', agent_wren: 'wren', 'app:site:flabs': 'site:flabs' };
const name = (p: string): string => names[p] ?? p;

const mine = m('human', 'agent_atlas', 'Ship the cache driver?', T - 900_000, new Date(T - 800_000).toISOString());
const readReply = m('agent_atlas', 'human', 'Shipped it earlier.', T - 600_000, new Date(T - 500_000).toISOString());
const chatter = m('agent_atlas', 'agent_wren', 'drop the challenges table', T - 400_000, null);
const appNote = m('app:site:flabs', 'human', 'A proposal waits for you', T - 300_000, null, {
    app: { label: 'site:flabs', subject: 'Proposal waiting', level: 'info', link: 'https://flabs.gen/p/1', source: { kind: 'site', name: 'flabs' } },
});
const ask = m('agent_wren', 'human', 'Which **port** should the site use?', T - 120_000, null);
const MAIL = [mine, readReply, chatter, appNote, ask];

describe('the person’s mail (core)', () => {
    it('only mail addressed to the person, newest first — not agent-to-agent, not what the person sent', () => {
        expect(personItems(MAIL, name).map((i) => i.id)).toEqual([ask.id, appNote.id, readReply.id]);
    });

    it('each message once: the snapshot’s unread and recent lists overlap', () => {
        expect(personItems([ask, appNote, ...MAIL], name).map((i) => i.id)).toEqual([ask.id, appNote.id, readReply.id]);
    });

    it('unread is the person’s unread mail only (an agent’s uncollected mail is not the person’s)', () => {
        expect(personUnread(MAIL)).toBe(2);
        const items = personItems(MAIL, name);
        expect(items.map((i) => i.unread)).toEqual([true, true, false]);
    });

    it('an item knows who sent it, when, its conversation, and an app’s subject and link', () => {
        const [first, app] = personItems(MAIL, name);
        expect(first).toMatchObject({ from: 'agent_wren', fromName: 'wren', kind: 'agent', at: T - 120_000, threadKey: pairKey('agent_wren', 'human'), text: ask.text });
        expect(app).toMatchObject({ kind: 'app', fromName: 'site:flabs', subject: 'Proposal waiting', level: 'info', link: 'https://flabs.gen/p/1' });
    });

    it('the list holds at most PERSON_INBOX_MAX, the newest', () => {
        const many = Array.from({ length: PERSON_INBOX_MAX + 5 }, (_, i) => m('agent_atlas', 'human', `n${i}`, T + i * 1000));
        const items = personItems(many, name);
        expect(items).toHaveLength(PERSON_INBOX_MAX);
        expect(items[0]!.text).toBe(`n${PERSON_INBOX_MAX + 4}`);
    });

    it('`inbox=you` is the person’s inbox; the threads (``), a thread and a message are not', () => {
        expect(PERSON_INBOX).toBe('you');
        expect(isPersonInbox('you')).toBe(true);
        for (const v of ['', pairKey('human', 'agent_atlas'), 'msg_3', null, undefined]) expect(isPersonInbox(v)).toBe(false);
    });

    it('CONTROL: no mail, no items and nothing unread', () => {
        expect(personItems([], name)).toEqual([]);
        expect(personUnread([])).toBe(0);
    });
});

const noop = () => {};
const ITEMS: PersonItem[] = personItems(MAIL, name);
const view = (over: Partial<PersonInboxViewProps> = {}) => renderToStaticMarkup(
    <PersonInboxView items={ITEMS} openId={null} now={T} onOpen={noop} onReply={noop} onMarkAllRead={noop} onClose={noop} {...over} />,
);

describe('the list', () => {
    it('each item: who, when, one line; unread marked; nothing of the agents’ own mail', () => {
        const html = view();
        expect(html).toContain('data-person-inbox=""');
        for (const id of [ask.id, appNote.id, readReply.id]) expect(html).toContain(`data-person-item="${id}"`);
        expect(html).toMatch(new RegExp(`data-person-item="${ask.id}"[^>]*data-unread="true"`));
        expect(html).toMatch(new RegExp(`data-person-item="${readReply.id}"[^>]*data-unread="false"`));
        expect(html).toContain('wren');
        expect(html).toContain('2m');
        expect(html).not.toContain('challenges');
    });

    it('an open item shows its whole text in place, with Reply to its conversation; a closed one does not', () => {
        const closed = view();
        expect(closed).not.toContain('data-person-open');
        expect(closed).not.toContain('data-person-reply');
        const open = view({ openId: ask.id });
        expect(open).toContain(`data-person-open="${ask.id}"`);
        expect(open).toContain('<strong>port</strong>');
        expect(open).toContain(`data-person-reply="${pairKey('agent_wren', 'human')}"`);
    });

    it('an app’s item opens on its link back into the app', () => {
        const html = view({ openId: appNote.id });
        expect(html).toMatch(/data-person-link="https:\/\/flabs\.gen\/p\/1"/);
        expect(html).toContain('Proposal waiting');
    });

    it('nothing for the person: a few words, no list', () => {
        const html = view({ items: [] });
        expect(html).toContain('data-person-empty=""');
        expect(html).not.toContain('data-person-item');
    });

    it('Mark all read only while something is unread', () => {
        expect(view()).toContain('data-person-mark-all=""');
        expect(view({ items: ITEMS.map((i) => ({ ...i, unread: false })) })).not.toContain('data-person-mark-all');
        expect(view({ items: [] })).not.toContain('data-person-mark-all');
    });
});

describe('opening an item (live DOM)', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); });
    const click = (sel: string): void => {
        const el = host.querySelector<HTMLElement>(sel);
        if (!el) throw new Error(`no ${sel}`);
        act(() => el.click());
    };

    it('a click opens it in place and marks it read; Reply goes to its conversation', () => {
        const read: string[] = [];
        const replies: string[] = [];
        act(() => root.render(<PersonInbox open items={ITEMS} onMarkRead={(id) => read.push(id)} onMarkAllRead={noop} onReply={(k) => replies.push(k)} onClose={noop} />));
        click(`[data-person-item="${ask.id}"]`);
        expect(read).toEqual([ask.id]);
        expect(host.querySelector(`[data-person-open="${ask.id}"]`)).not.toBeNull();
        click(`[data-person-reply="${pairKey('agent_wren', 'human')}"]`);
        expect(replies).toEqual([pairKey('agent_wren', 'human')]);
    });

    it('opening one already read marks nothing; a second click closes it', () => {
        const read: string[] = [];
        act(() => root.render(<PersonInbox open items={ITEMS} onMarkRead={(id) => read.push(id)} onMarkAllRead={noop} onReply={noop} onClose={noop} />));
        click(`[data-person-item="${readReply.id}"]`);
        expect(host.querySelector(`[data-person-open="${readReply.id}"]`)).not.toBeNull();
        click(`[data-person-item="${readReply.id}"]`);
        expect(host.querySelector('[data-person-open]')).toBeNull();
        expect(read).toEqual([]);
    });

    it('the rail row toggles it', () => {
        let toggled = 0;
        act(() => root.render(<Sidebar route="genie://dashboard" deckCount={0} workspaces={[]} available={['dashboard']} onNavigate={noop} railStorage={null}
            personInbox={{ unread: 2, open: false, onToggle: () => { toggled += 1; } }} />));
        click('[data-person-inbox-row]');
        expect(toggled).toBe(1);
    });
});

const ws = (id: string): RailItem => ({ id, path: `/w/${id}`, name: id, count: 1, alert: null } as RailItem);
function memory(collapsed: boolean): Pick<Storage, 'getItem' | 'setItem'> {
    const data = new Map<string, string>([['genie.rail.collapsed', collapsed ? '1' : '0']]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}
const rail = (personInbox: Parameters<typeof Sidebar>[0]['personInbox'], collapsed = false) => renderToStaticMarkup(
    <Sidebar route="genie://dashboard" deckCount={0} workspaces={[ws('tynn')]} available={['dashboard', 'genie', 'workspace', 'settings']} onNavigate={noop} railStorage={memory(collapsed)}
        {...(personInbox ? { personInbox } : {})} />,
);

describe('the rail row', () => {
    it('expanded: Inbox, right under the Dashboard, with the unread count', () => {
        const html = rail({ unread: 3, open: false, onToggle: noop });
        expect(html).toMatch(/data-nav="genie:\/\/dashboard"[\s\S]*data-person-inbox-row="closed"[\s\S]*data-nav="genie:\/\/agent\/genie"/);
        expect(html).toContain('data-person-inbox-badge="3"');
        expect(html).toContain('>Inbox<');
        expect(rail({ unread: 3, open: true, onToggle: noop })).toContain('data-person-inbox-row="open"');
    });

    it('no unread (0) or not read yet (null): the row, and no count — never a 0', () => {
        for (const unread of [0, null]) {
            const html = rail({ unread, open: false, onToggle: noop });
            expect(html).toContain('data-person-inbox-row');
            expect(html).not.toContain('data-person-inbox-badge');
        }
    });

    it('collapsed: still one click, its count said in words', () => {
        const html = rail({ unread: 2, open: false, onToggle: noop }, true);
        expect(html).toContain('data-rail="collapsed"');
        expect(html).toContain('data-person-inbox-row');
        expect(html).toContain('2 unread');
    });

    it('CONTROL: no inbox wired, no row', () => {
        expect(rail(undefined)).not.toContain('data-person-inbox-row');
    });
});

describe('in the shell', () => {
    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, workspaces: [{ id: 'ws', path: '/w/tynn', name: 'tynn', agentsKnown: true }] };
    const features: FeatureData = {
        ...EMPTY_FEATURES,
        inbox: { unread: [appNote, ask] as never, peers: [], recent: MAIL as never, threads: [], uncollected: 1 },
    };
    const shell = (route: string) => renderToStaticMarkup(
        <Shell
            route={route} snapshot={snapshot} servable={['dashboard', 'agent', 'workspace', 'settings']}
            agentDetail={null} agentResolved={false} selectedRowId={null} chatThread={null} pinned={null} files={NO_FILES}
            features={features} featureAsk={async () => features}
            onNavigate={noop} onOpenAgent={noop} onAddAgent={noop} onAddWorkspace={noop} onOpenPalette={noop} onSelectRow={noop}
            onSend={noop} onToggleFilesPin={noop} onCloseChat={noop} answeringApproval={null} onAnswerApproval={noop} onAnswerDeckItem={noop} onFeature={noop}
        />,
    );

    it('`inbox=you` opens the person’s inbox over the page — not the AgentInbox; the rail row reads open', () => {
        const html = shell('genie://dashboard?inbox=you');
        expect(html).toContain('data-person-inbox-drawer=""');
        expect(html).toContain(`data-person-item="${ask.id}"`);
        expect(html).not.toContain(`data-person-item="${chatter.id}"`);
        expect(html).not.toContain('data-inbox-flyout');
        expect(html).toContain('data-inbox-icon="closed"');
        expect(html).toContain('data-person-inbox-row="open"');
    });

    it('the rail row’s count is the person’s unread mail', () => {
        expect(shell('genie://dashboard')).toContain('data-person-inbox-badge="2"');
    });

    it('CONTROL: `inbox=` still opens the AgentInbox, and not the person’s inbox', () => {
        const html = shell('genie://dashboard?inbox=');
        expect(html).toContain('data-inbox-flyout');
        expect(html).not.toContain('data-person-inbox-drawer');
    });
});
