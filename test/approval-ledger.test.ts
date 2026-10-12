import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import { chipRow } from '../src/core/session-timeline.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { facetsOf, ledgerRow, visibleRows, type TimedEvent } from '../src/core/stream-view.js';
import { openDurableStore } from '../src/core/thread-store.js';

/**
 * A DECISION ON A PERMISSION REQUEST IS A LEDGER ROW (the chips row's `Approvals`, the ledger's history). The parked
 * request is state — the card — until the human answers; the answer is a fact worth a line, kept with the
 * conversation: `allowed · Bash · php artisan migrate --force`. A stop that abandons a parked request writes
 * `cancelled`. The chip counts the decisions the ledger actually holds, never a request it cannot see.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noProcessTree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function open() {
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
        return driver;
    };
    const dir = mkdtempSync(join(tmpdir(), 'genie2-approval-'));
    dirs.push(dir);
    const rows: StreamEvent[] = [];
    const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noProcessTree, onEvent: (e) => { rows.push(e); } });
    session.start();
    const ask = () => events.onRequestPermission?.({ toolCall: { title: 'php artisan migrate --force' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
    return { session, rows, ask, decisions: () => rows.filter((r) => r.kind === 'approval') };
}

describe('the session mints the decision', () => {
    it('allowed / denied with the provider’s option id; nothing while the request is only parked', () => {
        const a = open();
        void a.ask();
        expect(a.decisions()).toEqual([]);
        expect(a.session.answerApproval('allow')).toBe(true);
        expect(a.decisions()).toEqual([{ kind: 'approval', question: 'php artisan migrate --force', tool: null, outcome: 'allowed', optionId: 'allow' }]);

        const b = open();
        void b.ask();
        b.session.answerApproval('deny');
        expect(b.decisions().map((r) => r.kind === 'approval' && r.outcome)).toEqual(['denied']);
    });

    it('a stop with a request parked writes `cancelled`; a stop with none writes nothing (positive control)', async () => {
        const a = open();
        void a.ask();
        await a.session.stop();
        expect(a.decisions().map((r) => r.kind === 'approval' && r.outcome)).toEqual(['cancelled']);

        const b = open();
        await b.session.stop();
        expect(b.decisions()).toEqual([]);
    });
});

describe('the row and the facet', () => {
    const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
    const decision = (outcome: 'allowed' | 'denied' | 'answered' | 'cancelled'): StreamEvent => ({ kind: 'approval', question: 'php artisan migrate --force', tool: 'Bash', outcome, optionId: null });

    it('reads as the decision, the tool and the question, in mono, toned by the outcome', () => {
        expect(ledgerRow(t('a', decision('allowed')))).toMatchObject({ kind: 'approval', icon: 'check', tone: 'emerald', mono: true, main: 'allowed · Bash · php artisan migrate --force' });
        expect(ledgerRow(t('d', decision('denied')))).toMatchObject({ icon: 'x', tone: 'bad', main: 'denied · Bash · php artisan migrate --force' });
        expect(ledgerRow(t('c', decision('cancelled')))).toMatchObject({ icon: 'x', tone: 'muted' });
        expect(ledgerRow(t('n', { kind: 'approval', question: 'php artisan migrate --force', tool: null, outcome: 'answered', optionId: null }))).toMatchObject({ main: 'answered · php artisan migrate --force' });
    });

    it('is the Approvals facet — counted by the chip, shown under the Approvals filter, not under any lane', () => {
        const rows = [t('t1', { kind: 'turn', n: 1, by: 'you' }), t('a', decision('allowed')), t('u', { kind: 'usage', used: 1, size: 2, cost: null })];
        expect(facetsOf(decision('allowed'))).toEqual(['approvals']);
        expect(chipRow(rows, null).find((c) => c.id === 'approvals')).toEqual({ id: 'approvals', label: 'Approvals', n: 1, on: false });
        expect(visibleRows(rows, ['approvals']).map((r) => r.id)).toEqual(['t1', 'a']);
        expect(visibleRows(rows, ['tools']).map((r) => r.id)).toEqual(['t1']);
    });
});
