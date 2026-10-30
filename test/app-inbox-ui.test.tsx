import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Drawer } from '@particle-academy/react-fancy';
import { inboxThreads, pairKey, type ThreadMail } from '../src/core/inbox-threads.js';
import { AppInboxCard, type AppInboxCardProps } from '../src/renderer/components/AppInboxCard.js';
import { InboxFlyoutView, type InboxFlyoutViewProps } from '../src/renderer/components/InboxFlyout.js';
import type { InboxThreadView } from '../src/renderer/features.js';

/**
 * WHAT THE PERSON SEES OF APP MAIL (genie#1345). The owner's rules: icons over words, every action visibly in progress
 * and then a result, never silent. App mail reads as an app's at a glance (its own icon, never an agent's swatch), its
 * text is shown as PLAIN text — an app cannot draw links or fake UI in the person's flyout — and the thread is
 * read-only. The workspace card lists what holds a key, makes a script key and shows it ONCE.
 */

const T = Date.UTC(2026, 9, 30, 22, 0, 0);
const app = { source: { kind: 'site' as const, id: 'site_flabs', name: 'flabs', workspaceId: 'fancy' }, label: 'site:flabs@fancy', subject: '3 petitions queued', level: 'failure' as const, link: 'https://flabs.gen/council/42' };
const appMail: ThreadMail & { app: typeof app } = { seq: 1, id: 'msg_1', from: 'app:site:site_flabs', to: 'agent_clerk', text: '[Click here](https://evil.example) **now**', attachments: [], sentAt: new Date(T - 60_000).toISOString(), readAt: null, app };
const agentMail: ThreadMail = { seq: 2, id: 'msg_2', from: 'agent_scribe', to: 'agent_clerk', text: '**bold** from an agent', attachments: [], sentAt: new Date(T - 30_000).toISOString(), readAt: null };
const names: Record<string, string> = { agent_clerk: 'clerk', agent_scribe: 'scribe', 'app:site:site_flabs': 'site:flabs@fancy' };
const threads = inboxThreads([appMail, agentMail], (p) => names[p] ?? p);
const key = pairKey(appMail.from, appMail.to);
const noop = () => {};
const props = (over: Partial<InboxFlyoutViewProps> = {}): InboxFlyoutViewProps => ({
    threads, peers: [], thread: null, openKey: null, query: '', filter: 'all', now: T, uncollected: 2, unread: 0, draft: '',
    onQuery: noop, onFilter: noop, onOpenThread: noop, onLoadOlder: noop, onDraft: noop, onSend: noop, onDownload: noop, onMarkAllRead: noop, onDelete: noop, onClose: noop,
    ...over,
});
const html = (p: InboxFlyoutViewProps) => renderToStaticMarkup(<Drawer open onClose={noop} attach="container"><InboxFlyoutView {...p} /></Drawer>);

describe('the flyout', () => {
    it('an app’s thread carries the app’s icon, not a lock or an agent swatch; an agent pair keeps its lock (both ways)', () => {
        const out = html(props());
        expect(out).toMatch(new RegExp(`data-inbox-thread="${key.replace(/[|]/g, '\\|')}"[\\s\\S]*?data-app-sender="site"`));
        expect(out).toContain('data-app-icon="globe"');
        const agentKey = pairKey(agentMail.from, agentMail.to);
        expect(out).toMatch(new RegExp(`data-inbox-thread="${agentKey.replace(/[|]/g, '\\|')}"[\\s\\S]*?data-thread-lock`));
    });

    it('an app message: its subject, a level icon, the link as its own button, the body as PLAIN text, read-only', () => {
        const thread: InboxThreadView = { key, messages: [appMail] as never, more: false, limit: 50, focus: null };
        const out = html(props({ thread, openKey: key }));
        expect(out).toContain('data-app-message="site"');
        expect(out).toContain('3 petitions queued');
        expect(out).toContain('data-app-level="failure"');
        expect(out).toContain('data-app-link="https://flabs.gen/council/42"');
        // The body is text: no anchor to evil.example, no <strong>; the raw characters are there to read.
        expect(out).not.toContain('href="https://evil.example"');
        expect(out).not.toMatch(/<strong>now<\/strong>/);
        expect(out).toContain('[Click here](https://evil.example) **now**');
        expect(out).not.toContain('data-inbox-composer');
        expect(out).toContain('read-only');
    });

    it('an agent’s message is still rendered as Markdown (the other direction)', () => {
        const agentKey = pairKey(agentMail.from, agentMail.to);
        const thread: InboxThreadView = { key: agentKey, messages: [agentMail] as never, more: false, limit: 50, focus: null };
        const out = html(props({ thread, openKey: agentKey }));
        expect(out).toMatch(/<strong>bold<\/strong>/);
        expect(out).not.toContain('data-app-message');
    });
});

const card = (over: Partial<AppInboxCardProps> = {}) => renderToStaticMarkup(
    <AppInboxCard
        state={{ url: 'http://127.0.0.1:47432', enabled: true, sources: [{ kind: 'site', id: 'site_flabs', name: 'flabs' }, { kind: 'process', id: 'proc_1', name: 'queue' }], revoked: [{ kind: 'process', id: 'proc_2', name: 'old-worker' }], scriptKeys: [{ id: 'key_1', name: 'nightly', createdAt: new Date(T - 86_400_000).toISOString(), lastUsedAt: null }] }}
        busy={null}
        revealed={null}
        outcome={null}
        now={T}
        onCreateKey={noop} onRevokeKey={noop} onRotate={noop} onRevoke={noop} onAllow={noop} onDismissReveal={noop}
        {...over}
    />,
);

describe('the workspace’s Apps and scripts card', () => {
    it('lists each source by icon and name, with Rotate and Revoke; a revoked one with Allow', () => {
        const out = card();
        expect(out).toContain('data-app-source="site:site_flabs"');
        expect(out).toContain('data-app-source="process:proc_1"');
        expect(out).toMatch(/data-app-source="site:site_flabs"[\s\S]*?data-app-icon="globe"/);
        expect(out).toMatch(/data-app-source="process:proc_1"[\s\S]*?data-app-icon="cog"/);
        expect(out).toContain('data-action="app-rotate"');
        expect(out).toContain('data-action="app-revoke"');
        expect(out).toMatch(/data-app-revoked="process:proc_2"[\s\S]*?data-action="app-allow"/);
        expect(out).toContain('http://127.0.0.1:47432');
    });

    it('lists script keys without any secret, each with Revoke; and offers to make one', () => {
        const out = card();
        expect(out).toContain('data-script-key="key_1"');
        expect(out).toContain('nightly');
        expect(out).toContain('data-action="script-key-revoke"');
        expect(out).toContain('data-form="script-key-create"');
        expect(out).not.toContain('gik_');
    });

    it('a new key is shown ONCE, with a copy button and how to use it', () => {
        const out = card({ revealed: { name: 'nightly', token: 'gik_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' } });
        expect(out).toContain('data-script-key-revealed=""');
        expect(out).toContain('gik_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
        expect(out).toContain('data-action="script-key-copy"');
        expect(out).toMatch(/shown once/i);
        expect(out).toContain('GENIE_INBOX_TOKEN');
    });

    it('an action in flight shows it — its button busy and disabled — and the result shows after, success or failure with Retry', () => {
        const busy = card({ busy: { action: 'rotate', target: 'site:site_flabs' } });
        expect(busy).toMatch(/data-action="app-rotate"[^>]*data-busy="true"|data-busy="true"[^>]*data-action="app-rotate"/);
        expect(busy).toMatch(/disabled=""[^>]*data-action="app-rotate"|data-action="app-rotate"[^>]*disabled=""/);
        expect(card({ outcome: { ok: true, text: 'Rotated: flabs restarted with its new key' } })).toMatch(/data-app-outcome="ok"[\s\S]*Rotated: flabs restarted/);
        const failed = card({ outcome: { ok: false, text: 'Could not revoke: gone', retry: noop } });
        expect(failed).toMatch(/data-app-outcome="failed"[\s\S]*Could not revoke: gone/);
        expect(failed).toContain('data-action="app-retry"');
    });

    it('switched off: says so, and holds no list', () => {
        const out = card({ state: { url: 'http://127.0.0.1:47432', enabled: false, sources: [], revoked: [], scriptKeys: [] } });
        expect(out).toContain('data-app-inbox-off=""');
    });
});
