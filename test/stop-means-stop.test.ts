import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import type { DriverEvents, SessionDriverFactory, TurnOutcomeLike } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { wireInboxPush } from '../src/main/inbox-push.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * STOP MEANS STOP UNTIL THE PERSON ACTS (genie#1565; the owner's screenshot, beta.58): Stop on a working Codex agent showed
 * "Stopped by you · 22:31" and, in the same minute, a new turn — "I'll collect the inbox message and check whether the
 * interrupted browser … finished."
 *
 * Measured in the owner's own record of that agent: the `stopped` row (`by: you`), 150 ms later a `turn` row `by:
 * genie`, then the `prompt_delivery … sent` of a Genie inbox notice that had been HELD since mid-turn (Codex refuses a
 * prompt in flight). That is `AgentSession.#flushAfterTurn` at the cancelled turn's end. Stopping only that path is not
 * enough: the dropped notice is untold, and the inbox push tells it again on the host's next event — so the wake pauses
 * too.
 *
 * The rule: after a turn THE PERSON stopped, held input is not sent (a Genie notice is dropped for its book to tell again;
 * anything else is left as a draft the person can send), and no inbox notice is handed over. The mail stays unread. The
 * person's next message, or their Send on a draft, lifts it, and the mail is told as usual. A turn the provider ended, or
 * one cancelled with nobody here asking, keeps today's behaviour: mail wakes agents with no typing (genie#1379).
 *
 * Real SessionHost, real inbox and reminders (composeServices), the real push; the drivers are fakes shaped like
 * prism-acp's (Codex refuses a prompt in flight and declares `ready`; Claude takes one and folds it). Each can cancel.
 */

const NOTICE_1 = 'You have 1 unread AgentInbox message; collect it with agentinbox receive.';
const CANCELLED: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'cancelled' };
const FINISHED: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: null };

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

interface Fake {
    prompts: string[];
    cancels: number;
    events: DriverEvents;
    becomeReady: () => Promise<void>;
}
const fakes = new Map<string, Fake>();

const driverFor: DriverFor = (record) => {
    if (record.provider !== 'claude' && record.provider !== 'codex') return null;
    const factory: SessionDriverFactory = (options) => {
        let resolve: () => void = () => {};
        const ready = new Promise<void>((r) => { resolve = r; });
        let inFlight = false;
        const fake: Fake = {
            prompts: [],
            cancels: 0,
            events: options.events,
            becomeReady: async () => { resolve(); await ready; await Promise.resolve(); },
        };
        fakes.set(record.id, fake);
        fake.events = { ...options.events, onTurnEnd: (o) => { inFlight = false; options.events.onTurnEnd?.(o); } };
        return {
            start: () => {},
            prompt: (content: unknown) => {
                if (record.provider === 'codex' && inFlight) throw new Error('Codex turn already in flight');
                inFlight = true;
                fake.prompts.push(String(content));
            },
            cancel: () => { fake.cancels += 1; return Promise.resolve(); },
            kill: () => {},
            cliSessionId: null,
            ...(record.provider === 'codex' ? { ready } : {}),
        };
    };
    return factory;
};

let dir: string;
let services: ComposedServices;
let host: SessionHost;
let roster: AgentRecord[];
let unwire: () => void;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-stop-means-stop-'));
    roster = [];
    fakes.clear();
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, docker: async () => ({ stdout: '', exitCode: 1 }), portFree: async () => true });
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
    unwire = wireInboxPush({
        inbox: services.inbox,
        host,
        reminders: (input) => services.inboxReminders(input),
        settled: (agentId, delivered) => services.inboxNoticeSettled(agentId, delivered),
        cumulative: true,
    });
});
afterEach(async () => {
    unwire();
    host.stopAll();
    await host.settled();
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const endTurn = (id: AgentId, outcome: TurnOutcomeLike = FINISHED): void => fakes.get(id)!.events.onTurnEnd?.(outcome);
const mail = async (to: AgentId, text: string): Promise<void> => { await services.inbox.send({ from: HUMAN as never, to, text }); };
const promptsOf = (id: AgentId): string[] => fakes.get(id)?.prompts ?? [];
const notices = (id: AgentId): string[] => promptsOf(id).filter((p) => p.includes('unread AgentInbox'));
const unread = (id: AgentId): number => services.inbox.unread(id).length;
const deliveries = (id: AgentId): Array<[string, string]> => host.rowsFor(id).map((r) => r.event)
    .flatMap((e) => (e.kind === 'prompt_delivery' ? [[e.id, e.status] as [string, string]] : []));
const pendingIdOf = (id: AgentId, text: string): string | null => {
    for (const { event: e } of host.rowsFor(id)) if (e.kind === 'message' && e.text === text && e.pending) return e.pending.id;
    return null;
};

describe.each(['codex', 'claude'] as const)('stop means stop — a %s agent', (provider) => {
    const register = (): AgentRecord => {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider, name: `${provider}-stop` });
        roster.push(record);
        return record;
    };
    /** Started, ready, and working on the person's turn. */
    const startWorking = async (record: AgentRecord): Promise<void> => {
        expect(host.start(record, dir)).toEqual({ ok: true });
        await fakes.get(record.id)!.becomeReady();
        expect(host.prompt(record.id, 'work', 'you')).toBe(true);
        expect(host.inTurn(record.id)).toBe(true);
    };
    /** The person presses Stop and the provider ends the turn cancelled. */
    const personStops = (record: AgentRecord): void => {
        expect(host.cancel(record.id)).toEqual({ ok: true });
        expect(fakes.get(record.id)!.cancels).toBe(1);
        endTurn(record.id, CANCELLED);
    };

    it('mail that ARRIVES AFTER the person stopped the turn does not wake it; it stays unread', async () => {
        const record = register();
        await startWorking(record);
        personStops(record);
        expect(host.probe(record.id)?.turnState).toBe('idle');
        await mail(record.id, 'after your stop');
        expect(promptsOf(record.id)).toEqual(['work']);
        expect(host.inTurn(record.id)).toBe(false);
        expect(unread(record.id)).toBe(1);
        // A host event for this agent (a redraw, a setting) is not a reason to tell it either.
        host.notice(record.id, 'something else changed');
        expect(promptsOf(record.id)).toEqual(['work']);
    });

    it('CONTROL — the turn ENDED by the provider: mail after it wakes the agent with nobody typing', async () => {
        const record = register();
        await startWorking(record);
        endTurn(record.id);
        await mail(record.id, 'after a finished turn');
        expect(promptsOf(record.id)).toEqual(['work', NOTICE_1]);
    });

    it('CONTROL — a turn cancelled with NOBODY here asking keeps today’s behaviour: mail after it wakes the agent', async () => {
        const record = register();
        await startWorking(record);
        endTurn(record.id, CANCELLED);
        expect(host.rowsFor(record.id).map((r) => r.event).filter((e) => e.kind === 'stopped')).toEqual([{ kind: 'stopped', n: 1, by: null }]);
        await mail(record.id, 'after a provider cancel');
        expect(promptsOf(record.id)).toEqual(['work', NOTICE_1]);
    });

    it('the person’s NEXT MESSAGE lifts the pause: their message goes, and the waiting mail is told as usual', async () => {
        const record = register();
        await startWorking(record);
        personStops(record);
        await mail(record.id, 'waiting for you');
        expect(notices(record.id)).toEqual([]);

        expect(host.prompt(record.id, 'carry on', 'you')).toBe(true);
        if (provider === 'claude') {
            // Claude takes the notice at its next step, folded into the person's turn.
            expect(promptsOf(record.id)).toEqual(['work', 'carry on', NOTICE_1]);
        } else {
            // Codex holds it for the end of the person's turn, then sends it as its own.
            expect(promptsOf(record.id)).toEqual(['work', 'carry on']);
            endTurn(record.id);
            expect(promptsOf(record.id)).toEqual(['work', 'carry on', NOTICE_1]);
        }
        endTurn(record.id);
        // Lifted for good: mail after this wakes it again with nobody typing.
        await services.inbox.receive({ participant: record.id });
        await mail(record.id, 'later');
        expect(notices(record.id)).toEqual([NOTICE_1, NOTICE_1]);
    });

    it('a message from someone other than the person (a peer, Genie) does NOT lift the pause', async () => {
        const record = register();
        await startWorking(record);
        personStops(record);
        await mail(record.id, 'waiting for you');
        host.prompt(record.id, 'from a peer', 'wren');
        endTurn(record.id);
        // The peer's own prompt went (it is not inbox mail), but no notice rode on it or followed it.
        expect(notices(record.id)).toEqual([]);
        expect(unread(record.id)).toBe(1);
    });

    if (provider === 'codex') {
        it('CODEX, the owner’s case: a notice HELD mid-turn is not sent when the person stops; no new turn, the mail stays unread', async () => {
            const record = register();
            await startWorking(record);
            await mail(record.id, 'arrived mid-turn');
            // Held: Codex refuses a prompt in flight.
            expect(promptsOf(record.id)).toEqual(['work']);
            const held = pendingIdOf(record.id, NOTICE_1);
            expect(held).not.toBeNull();
            expect(host.hasQueuedPrompt(record.id, held!)).toBe(true);

            personStops(record);
            expect(promptsOf(record.id)).toEqual(['work']);
            expect(host.inTurn(record.id)).toBe(false);
            expect(host.probe(record.id)?.turnState).toBe('idle');
            expect(host.rowsFor(record.id).map((r) => r.event).filter((e) => e.kind === 'turn')).toHaveLength(1);
            // Genie's notice is Genie's to tell again: dropped, never sent, never an owed draft.
            expect(deliveries(record.id)).toEqual([[held!, 'discarded']]);
            expect(unread(record.id)).toBe(1);
        });

        it('CODEX CONTROL: the same held notice IS sent when the turn ends normally', async () => {
            const record = register();
            await startWorking(record);
            await mail(record.id, 'arrived mid-turn');
            const held = pendingIdOf(record.id, NOTICE_1);
            endTurn(record.id);
            expect(promptsOf(record.id)).toEqual(['work', NOTICE_1]);
            expect(deliveries(record.id)).toEqual([[held!, 'sent']]);
        });

        /*
         * THE PERSON'S OWN QUEUED MESSAGE IS THE PERSON ACTING (genie#1143: "Cancelling a turn preserves the queue";
         * test/queued-input.test.tsx holds it). They wrote it, and it shows as Queued; Claude, too, runs a message taken
         * mid-turn after the interrupt (test/stop-cancels-turn.test.ts). So it goes, as its own turn — and a Genie notice
         * held BEFORE it does not ride ahead of it: dropped, and told as usual once the person's turn ends.
         */
        it('CODEX: the person’s OWN message held mid-turn still goes after their stop; a notice held ahead of it does not', async () => {
            const record = register();
            await startWorking(record);
            await mail(record.id, 'arrived mid-turn');
            const notice = pendingIdOf(record.id, NOTICE_1);
            host.prompt(record.id, 'also do this', 'you');
            const yours = pendingIdOf(record.id, 'also do this');
            expect(notice).not.toBeNull();
            expect(yours).not.toBeNull();

            personStops(record);
            expect(promptsOf(record.id)).toEqual(['work', 'also do this']);
            expect(new Map(deliveries(record.id))).toEqual(new Map([[notice!, 'discarded'], [yours!, 'sent']]));
            endTurn(record.id);
            expect(promptsOf(record.id)).toEqual(['work', 'also do this', NOTICE_1]);
        });

        it('CODEX: a PEER’s message held mid-turn becomes a DRAFT at the person’s stop, not a turn; the person’s Send on it lifts the pause', async () => {
            const record = register();
            await startWorking(record);
            host.prompt(record.id, 'from wren', 'wren');
            await mail(record.id, 'arrived mid-turn');
            const draft = pendingIdOf(record.id, 'from wren');
            expect(draft).not.toBeNull();

            personStops(record);
            expect(promptsOf(record.id)).toEqual(['work']);
            expect(new Map(deliveries(record.id)).get(draft!)).toBe('undelivered');

            await expect(host.resolvePrompt(record.id, draft!, 'send')).resolves.toEqual({ ok: true });
            expect(promptsOf(record.id)).toEqual(['work', 'from wren']);
            endTurn(record.id);
            expect(promptsOf(record.id)).toEqual(['work', 'from wren', NOTICE_1]);
        });
    }

    if (provider === 'claude') {
        it('CLAUDE: after the person’s stop, a host event with mail waiting starts nothing (the same push path Codex takes)', async () => {
            const record = register();
            await startWorking(record);
            personStops(record);
            await mail(record.id, 'one');
            await mail(record.id, 'two');
            expect(promptsOf(record.id)).toEqual(['work']);
            expect(unread(record.id)).toBe(2);
        });
    }
});
