import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { mintAgentId } from '../src/core/identity.js';
import { MAIL_SIGNAL_MS, mailSignals, type MailSignal } from '../src/core/mail-signals.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * MAIL BETWEEN AGENTS IS SEEN ON THE DASHBOARD (genie#1209; the owner, 2026-10-26: "I also want to see a signal
 * animation when one agent sends another agent a msg. It should travel from the agent sending to the agent receiving with
 * indication when read"). The window was told only that an agent sent mail (`agentmail`, for its sound) — not to whom,
 * and never when it was read. Now a send says who to and which message; a read says which messages; the Dashboard draws
 * each signal from the sender's row to the recipient's, and marks it read.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-mail-signal-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

describe('the mailbox says WHICH messages were read', () => {
    it('a receive that reads two messages reports both ids; reading again reports none (CONTROL: the reader is still named)', async () => {
        const store = await InboxStore.open(dir);
        const a = mintAgentId();
        const b = mintAgentId();
        const one = await store.send({ from: a, to: b, text: 'one' });
        const two = await store.send({ from: a, to: b, text: 'two' });
        const reads: Array<{ reader: string; ids: readonly string[] }> = [];
        store.onRead((reader, ids) => reads.push({ reader, ids: ids ?? [] }));
        await store.receive({ participant: b });
        await store.receive({ participant: b });
        expect(reads[0]).toEqual({ reader: b, ids: [one.id, two.id] });
        expect(reads.slice(1).every((r) => r.ids.length === 0)).toBe(true);
    });
});

describe('the signals the Dashboard draws', () => {
    const T0 = 1_000_000;
    it('a send starts one from the sender to the recipient; its read marks it; it goes after MAIL_SIGNAL_MS from the last change', () => {
        let s: readonly MailSignal[] = [];
        s = mailSignals(s, { kind: 'sent', id: 'm1', from: 'kai', to: 'wren', at: T0 });
        s = mailSignals(s, { kind: 'sent', id: 'm2', from: 'wren', to: 'human', at: T0 });
        expect(s).toEqual([{ id: 'm1', from: 'kai', to: 'wren', sentAt: T0, readAt: null }]);
        s = mailSignals(s, { kind: 'read', ids: ['m1', 'mX'], at: T0 + 2_000 });
        expect(s).toEqual([{ id: 'm1', from: 'kai', to: 'wren', sentAt: T0, readAt: T0 + 2_000 }]);
        expect(mailSignals(s, { kind: 'tick', at: T0 + 2_000 + MAIL_SIGNAL_MS - 1 })).toHaveLength(1);
        expect(mailSignals(s, { kind: 'tick', at: T0 + 2_000 + MAIL_SIGNAL_MS })).toEqual([]);
    });
});

describe('on the board', () => {
    const row = (id: string): AgentRow => ({
        id, name: id, workspaceId: 'ws', state: 'working', provider: 'claude', fidelity: 'declared', duration: null,
        ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
        collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
    } as AgentRow);

    it('each signal is drawn from its sender to its recipient, and says whether it was read', () => {
        const html = renderToStaticMarkup(<Dashboard
            workspaces={[{ id: 'ws', name: 'ws', path: '/ws' }]} rows={[row('kai'), row('wren')]} genie={null}
            onOpenAgent={() => {}} onAddAgent={() => {}}
            mailSignals={[{ id: 'm1', from: 'kai', to: 'wren', sentAt: 1, readAt: null }, { id: 'm2', from: 'wren', to: 'kai', sentAt: 1, readAt: 5 }]}
        />);
        expect(html).toMatch(/data-mail-signal="m1"[^>]*data-from="kai"[^>]*data-to="wren"[^>]*data-read="false"/);
        expect(html).toMatch(/data-mail-signal="m2"[^>]*data-from="wren"[^>]*data-to="kai"[^>]*data-read="true"/);
    });
});
