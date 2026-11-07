import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appSenderId, type AppMessageMeta } from '../src/core/app-inbox.js';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { deliveryHeader as reminderText, summarizeInboxPrompt } from './helpers/inbox-delivery.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';
import { sessionsDir } from '../src/main/paths.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { wireInboxPush, type InboxPushPorts } from '../src/main/inbox-push.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE INBOX PUSH IS GENIE'S, FOR EVERY PROVIDER (B26). When mail lands for an agent, Genie puts the notice into that
 * agent's own session: at once when it is idle; when it is MID-TURN, at its next step, exactly as the person's typed
 * message arrives (genie#1411: Claude folds it into the running turn, Codex holds it for the turn's end); when it is
 * still starting, the moment it is ready. Exactly once per arrival batch. Nothing here leans on a provider feature —
 * no hook, no MCP notification, no provider interrupt: the drivers below are fakes that can do nothing but take a
 * prompt and report a turn's end, which is all the real ones are asked to do.
 *
 * The owner's timeline (beta.27): a Codex sidecar was started and mailed at once; the mail showed in its chat, the
 * notice did not — it arrived only after the person had typed twice and Codex had answered.
 *
 * The fakes are shaped like prism-acp's real drivers: Codex declares `ready` (its thread is started), Claude does not.
 */

const NOTICE_1 = reminderText(1);
const notice = (n: number): string => reminderText(n);

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

interface Fake {
    prompts: string[];
    events: DriverEvents;
    becomeReady: () => Promise<void>;
    /** The next prompt is REFUSED with this error (the driver throws), as a real driver can. */
    refuseNext: string | null;
}
const fakes = new Map<string, Fake>();

const driverFor: DriverFor = (record) => {
    if (record.provider !== 'claude' && record.provider !== 'codex') return null;
    const factory: SessionDriverFactory = (options) => {
        let resolve: () => void = () => {};
        const ready = new Promise<void>((r) => { resolve = r; });
        const fake: Fake = {
            prompts: [],
            events: options.events,
            becomeReady: async () => { resolve(); await ready; await Promise.resolve(); },
            refuseNext: null,
        };
        fakes.set(record.id, fake);
        let inFlight = false;
        const driver = {
            start: () => {},
            prompt: (content: unknown) => {
                const refused = fake.refuseNext;
                if (refused !== null) { fake.refuseNext = null; throw new Error(refused); }
                // prism-acp's CodexDriver refuses a second prompt while a turn runs; Genie must never send one.
                if (record.provider === 'codex' && inFlight) throw new Error('Codex turn already in flight');
                inFlight = true;
                fake.prompts.push(String(content));
            },
            kill: () => {},
            cliSessionId: null,
            ...(record.provider === 'codex' ? { ready } : {}),
        };
        // The test ends a turn the way the provider does; the fake clears its own in-flight mark first.
        fake.events = { ...options.events, onTurnEnd: (o) => { inFlight = false; options.events.onTurnEnd?.(o); } };
        return driver;
    };
    return factory;
};

let dir: string;
let services: ComposedServices;
let host: SessionHost;
let roster: AgentRecord[];
let unwire: () => void;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-inbox-push-'));
    roster = [];
    fakes.clear();
    // No Docker and no real port probes: this test is about the inbox, and the real ones made its setup the first thing
    // to time out on a loaded Windows machine (beta.28's Windows verify), as every other composeServices test avoids.
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

const endTurn = (id: AgentId): void => fakes.get(id)!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
/** Wire the push again with more ports (an app wake cap, a coalescing window) over the same inbox and host. */
const rewire = (extra: Partial<InboxPushPorts>): void => {
    unwire();
    unwire = wireInboxPush({
        inbox: services.inbox,
        host,
        reminders: (input) => services.inboxReminders(input),
        settled: (agentId, delivered) => services.inboxNoticeSettled(agentId, delivered),
        cumulative: true,
        ...extra,
    });
};
/** A timer the test fires by hand: nothing runs until `fire`. */
const handTimer = () => {
    const due: Array<() => void> = [];
    return {
        schedule: (fn: () => void): (() => void) => { due.push(fn); return () => { const i = due.indexOf(fn); if (i >= 0) due.splice(i, 1); }; },
        fire: (): void => { for (const fn of due.splice(0)) fn(); },
    };
};
const site: AppMessageMeta = { source: { kind: 'site', id: 'site_flabs', name: 'flabs', workspaceId: 'tynn' }, label: 'site:flabs@tynn', subject: 'petition queued', level: 'info' };
const APP_FROM = appSenderId(site.source);
const appMail = async (to: AgentId, text = 'petition #42 queued'): Promise<void> => { await services.inbox.send({ from: APP_FROM, to, text, app: site }); };
const mail = async (to: AgentId, text: string, from: string = HUMAN): Promise<void> => { await services.inbox.send({ from: from as never, to, text }); };
const promptsOf = (id: AgentId): string[] => (fakes.get(id)?.prompts ?? []).map(summarizeInboxPrompt);
const notices = (id: AgentId): string[] => promptsOf(id).filter((p) => p.startsWith('AgentInbox delivery:'));

describe.each(['claude', 'codex'] as const)('the inbox push — a %s agent', (provider) => {
    const register = (): AgentRecord => {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider, name: `${provider}-slave` });
        roster.push(record);
        return record;
    };
    /** Started and, where the driver declares it, ready — the state the person sees as an agent waiting. */
    const startReady = async (record: AgentRecord): Promise<void> => {
        expect(host.start(record, dir)).toEqual({ ok: true });
        await fakes.get(record.id)!.becomeReady();
    };
    /** Started, ready, and one turn of the person's already run and ended: idle by every reading. */
    const startIdle = async (record: AgentRecord): Promise<void> => {
        await startReady(record);
        host.prompt(record.id, 'warm up', 'you');
        endTurn(record.id);
    };

    it('JUST STARTED and mailed at once (the owner\'s timeline): the notice is its first turn, as soon as it is ready — with nobody typing', async () => {
        const record = register();
        expect(host.start(record, dir)).toEqual({ ok: true });
        await mail(record.id, "Hi, I'm tynn");
        // Still starting: a driver that declares `ready` is not prompted before it is.
        if (provider === 'codex') expect(promptsOf(record.id)).toEqual([]);
        await fakes.get(record.id)!.becomeReady();
        expect(promptsOf(record.id)).toEqual([NOTICE_1]);
    });

    /*
     * COOLING IS DISPLAY ONLY (the owner, 2026-11-01): the 15 s after a clean turn end reads `Cooling` on the board, and
     * the push treats it as idle — the notice goes out at once, it does not wait the cooling out.
     */
    it('mailed while COOLING (its turn just ended): the notice goes out at once, not after the cooling', async () => {
        const record = register();
        await startReady(record);
        host.prompt(record.id, 'warm up', 'you');
        // POSITIVE CONTROL: mid-turn it is not cooling.
        expect(host.probe(record.id)?.cooling).toBe(false);
        endTurn(record.id);
        expect(host.probe(record.id)?.cooling).toBe(true);
        await mail(record.id, 'right after your turn');
        expect(notices(record.id)).toEqual([NOTICE_1]);
        // Delivered with no clock moving (real timers, 15 s cooling): it opened its turn now, which ends the cooling.
        expect(host.probe(record.id)?.turnState).toBe('working');
        expect(host.probe(record.id)?.cooling).toBe(false);
    });

    it('mailed while it is NOT RUNNING: the notice is delivered once it is started and ready', async () => {
        const record = register();
        await mail(record.id, 'while you were out');
        expect(host.start(record, dir)).toEqual({ ok: true });
        await fakes.get(record.id)!.becomeReady();
        expect(promptsOf(record.id)).toEqual([NOTICE_1]);
    });

    /*
     * THE NOTICE CARRIES ITS CONTEXT (beta.33 item 18; the owner: "I need to be able to see the context in agentInbox
     * deliveries"). The agent still gets the same short prompt — it collects the mail with `receive` — but the notice's
     * row in the ledger names the messages it told about: who from, and what each says, as they were when told. The
     * chat reads it from there, and from the recorded thread after a restart.
     */
    it('the notice’s ledger row names the messages it told about — who from and what each says — and is recorded so', async () => {
        const other = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider, name: 'wren' });
        roster.push(other);
        const record = register();
        await startIdle(record);
        await mail(record.id, 'Answer to your question q_1:\n- **Deploy** — Ship it?\n  → Yes');
        await services.inbox.receive({ participant: record.id });
        endTurn(record.id);
        // Two arriving in one coalescing window are one notice, naming both.
        const timer = handTimer();
        rewire({ schedule: timer.schedule, coalesceMs: 1_500 });
        await mail(record.id, 'one');
        await mail(record.id, 'two', other.id);
        timer.fire();
        endTurn(record.id);
        const notices = host.rowsFor(record.id).map((r) => r.event).filter((e) => e.kind === 'message' && e.speaker === 'peer' && e.peerName === 'genie');
        expect(notices.map((e) => (e.kind === 'message' ? summarizeInboxPrompt(e.text) : ''))).toEqual([NOTICE_1, notice(2)]);
        const told = notices.map((e) => (e.kind === 'message' ? (e.mail ?? []).map((m) => [m.from, m.fromName, m.text]) : []));
        expect(told).toEqual([
            [[HUMAN, null, 'Answer to your question q_1:\n- **Deploy** — Ship it?\n  → Yes']],
            [[HUMAN, null, 'one'], [other.id, 'wren', 'two']],
        ]);
        // Each by the inbox's own id and time, so the chat can open THAT message.
        const ids = services.inbox.unread(record.id).map((m) => m.id);
        expect(notices[1]!.kind === 'message' ? notices[1]!.mail!.map((m) => m.id) : []).toEqual(ids.slice(-2));
        // RECORDED: the thread holds the same context, so it survives a restart.
        await host.settled();
        const recorded = (await readHistory(openDurableStore(sessionsDir(dir)), record.id)).rows.map((r) => r.event)
            .filter((e) => e.kind === 'message' && e.speaker === 'peer' && e.peerName === 'genie');
        expect(recorded.map((e) => (e.kind === 'message' ? (e.mail ?? []).map((m) => m.text) : []))).toEqual([
            ['Answer to your question q_1:\n- **Deploy** — Ship it?\n  → Yes'],
            ['one', 'two'],
        ]);
    });

    it('IDLE: the notice is delivered at once', async () => {
        const record = register();
        await startIdle(record);
        await mail(record.id, 'ping');
        expect(promptsOf(record.id)).toEqual(['warm up', NOTICE_1]);
    });

    /*
     * MID-TURN, LIKE TYPED INPUT (genie#1411; the owner, 2026-11-01: "inbox nudges should queue up and post to the agent
     * as soon as possible just like user input"). Four messages waited 22 minutes under one long turn, because the push
     * asked only whether the session could take a NEW turn. The notice now goes the way the person's own message goes
     * (`AgentSession.deliver`): Claude takes it at once and folds it into the running turn; Codex refuses a prompt
     * mid-turn, so it is held and sent the moment the turn ends, as its own turn.
     */
    it('MID-TURN: told at its next step, the way typed input arrives (Claude now, Codex when the turn ends), and never twice', async () => {
        const record = register();
        await startReady(record);
        host.prompt(record.id, 'work', 'you');
        await mail(record.id, 'one');
        if (provider === 'claude') {
            // Folded into the running turn: one prompt, now.
            expect(promptsOf(record.id)).toEqual(['work', NOTICE_1]);
            endTurn(record.id);
            // Told when that turn ended cleanly: no second turn for the same batch.
            expect(promptsOf(record.id)).toEqual(['work', NOTICE_1]);
        } else {
            // Codex refuses a second prompt in flight: held, and sent the moment the turn ends, as its own turn.
            expect(promptsOf(record.id)).toEqual(['work']);
            endTurn(record.id);
            expect(promptsOf(record.id)).toEqual(['work', NOTICE_1]);
            endTurn(record.id);
            expect(promptsOf(record.id)).toEqual(['work', NOTICE_1]);
        }
        // Told: another of the person's turns re-announces nothing.
        host.prompt(record.id, 'more', 'you');
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1]);
    });

    it('MID-TURN: framed as Genie’s notice (`by: genie`), never the person’s words, naming the mail it told about', async () => {
        const record = register();
        await startReady(record);
        host.prompt(record.id, 'work', 'you');
        await mail(record.id, 'one');
        if (provider === 'claude') expect(notices(record.id)).toEqual([NOTICE_1]);
        endTurn(record.id);
        const rows = host.rowsFor(record.id).map((r) => r.event);
        const told = rows.filter((e) => e.kind === 'message' && summarizeInboxPrompt(e.text) === NOTICE_1);
        expect(told).toHaveLength(1);
        expect(told[0]).toMatchObject({ speaker: 'peer', peerName: 'genie' });
        expect(told[0]!.kind === 'message' ? (told[0]!.mail ?? []).map((m) => m.text) : []).toEqual(['one']);
    });

    it('MID-TURN, CODEX: a held notice is told only after ITS OWN turn ends; a crash there leaves it untold', async () => {
        if (provider !== 'codex') return;
        const record = register();
        await startReady(record);
        host.prompt(record.id, 'work', 'you');
        await mail(record.id, 'one');
        expect(notices(record.id)).toEqual([]);
        // The person's turn ends: the held notice goes, as its own turn. Not told yet.
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1]);
        // ITS turn crashes: it was not told. The person tries again; when that turn ends cleanly the batch is told again.
        fakes.get(record.id)!.events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'stream closed' });
        host.prompt(record.id, 'try again', 'you');
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1, NOTICE_1]);
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1, NOTICE_1]);
    });

    it('MID-TURN: the turn that took the notice CRASHES: untold, and told again once the agent can take a turn', async () => {
        const record = register();
        await startReady(record);
        host.prompt(record.id, 'work', 'you');
        await mail(record.id, 'one');
        fakes.get(record.id)!.events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'stream closed' });
        host.prompt(record.id, 'try again', 'you');
        endTurn(record.id);
        // Claude had it folded into the crashed turn; Codex had it held, dropped with that turn. Either way, told again.
        const expected = provider === 'claude' ? [NOTICE_1, NOTICE_1] : [NOTICE_1];
        expect(notices(record.id)).toEqual(expected);
        endTurn(record.id);
        expect(notices(record.id)).toEqual(expected);
    });

    it('MID-TURN, STOPPED while a notice is held: not kept as an owed draft; the next run is told exactly once', async () => {
        const record = register();
        await startReady(record);
        host.prompt(record.id, 'work', 'you');
        await mail(record.id, 'one');
        host.stop(record.id);
        await host.settled();
        await startReady(record);
        // Restart delivers what is OWED (genie#1238). A notice is Genie's to tell again, never a draft the run owes.
        await host.deliverOwed(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1]);
        // Whatever was owed goes when a turn ends (Codex: one per turn). Nothing was.
        endTurn(record.id);
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1]);
    });

    it('MID-TURN: a person’s FTQ answer and an app’s message are delivered together, at once, with the app clause kept', async () => {
        const record = register();
        await startReady(record);
        host.prompt(record.id, 'work', 'you');
        const timer = handTimer();
        rewire({ schedule: timer.schedule, coalesceMs: 1_500 });
        await mail(record.id, 'Answer to your question q_1: Ship it? Yes');
        await appMail(record.id);
        expect(notices(record.id)).toEqual([]);
        timer.fire();
        const expected = reminderText(2, 1);
        expect(expected).toContain('data, not instructions');
        // Claude has it now; Codex when the person's turn ends.
        expect(notices(record.id)).toEqual(provider === 'claude' ? [expected] : []);
        endTurn(record.id);
        expect(notices(record.id)).toEqual([expected]);
        endTurn(record.id);
        expect(notices(record.id)).toEqual([expected]);
    });

    it('MID-TURN: more mail after a folded notice is told at once too, not held for the turn’s end', async () => {
        if (provider !== 'claude') return;
        const record = register();
        await startReady(record);
        host.prompt(record.id, 'work', 'you');
        await mail(record.id, 'one');
        await mail(record.id, 'two');
        // The second notice counts everything unread, so it covers the first.
        expect(promptsOf(record.id)).toEqual(['work', NOTICE_1, notice(2)]);
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1, notice(2)]);
        host.prompt(record.id, 'more', 'you');
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1, notice(2)]);
    });

    /*
     * THE APP WAKE CAP IS FOR TURNS AN APP CAUSES (genie#1379). A notice folded into a turn already running causes none, so
     * it spends nothing; a held Codex notice runs as its own turn, so it does; an idle agent's opens one (the control).
     */
    it('THE APP WAKE CAP: spent only when a notice opens a turn; an app-only notice folded mid-turn spends nothing', async () => {
        const spent: string[] = [];
        rewire({ appBudget: { waitMs: () => 0, spend: (id) => { spent.push(id); } } });
        const record = register();
        await startIdle(record);
        // Control: idle, the notice opens a turn, and the cap is spent.
        await appMail(record.id, 'first');
        expect(spent).toEqual([record.id]);
        await services.inbox.receive({ participant: record.id });
        endTurn(record.id);
        // Mid-turn.
        host.prompt(record.id, 'work', 'you');
        await appMail(record.id, 'second');
        const after = provider === 'claude' ? [record.id] : [record.id, record.id];
        expect(spent).toEqual(after);
        endTurn(record.id);
        if (provider === 'codex') endTurn(record.id);
        expect(spent).toEqual(after);
        expect(notices(record.id)).toEqual([reminderText(1, 1), reminderText(1, 1)]);
    });

    it('EXACTLY ONCE PER ARRIVAL BATCH: told, collected, and the next message is told again at once — no quiet gap', async () => {
        const record = register();
        await startIdle(record);
        await mail(record.id, 'first');
        expect(notices(record.id)).toEqual([NOTICE_1]);
        await services.inbox.receive({ participant: record.id });
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1]);
        await mail(record.id, 'second');
        expect(notices(record.id)).toEqual([NOTICE_1, NOTICE_1]);
    });

    it('a told batch NOT collected is not repeated on every idle moment; new mail on top of it is told', async () => {
        const record = register();
        await startIdle(record);
        await mail(record.id, 'first');
        endTurn(record.id);
        host.prompt(record.id, 'something else', 'you');
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1]);
        await mail(record.id, 'second');
        expect(notices(record.id)).toEqual([NOTICE_1, notice(2)]);
    });
    it('a notice whose PROMPT IS REFUSED was not told: the batch goes out exactly once, on the next idle', async () => {
        const record = register();
        await startIdle(record);
        // A turn Genie did not start raced in: the driver refuses the notice (Codex says so in its own words).
        fakes.get(record.id)!.refuseNext = provider === 'codex' ? 'Codex turn already in flight' : 'driver is not started, or its stdin has closed';
        await mail(record.id, 'first');
        expect(notices(record.id)).toEqual([]);
        // That turn ends: the session is idle, and the untold batch is told — once.
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1]);
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1]);
    });

    it('a notice whose turn NEVER ENDS because the session is stopped was not told: the next run is told', async () => {
        const record = register();
        await startIdle(record);
        await mail(record.id, 'first');
        expect(notices(record.id)).toEqual([NOTICE_1]);
        host.stop(record.id);
        await startReady(record);
        expect(notices(record.id)).toEqual([NOTICE_1]);
    });

    it('a notice whose turn CRASHED was not told: told again on the next idle of the same run', async () => {
        const record = register();
        await startIdle(record);
        await mail(record.id, 'first');
        expect(notices(record.id)).toEqual([NOTICE_1]);
        fakes.get(record.id)!.events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'stream closed' });
        // Broken: nothing is sent to a broken session. The person tries again; that turn ends cleanly.
        expect(notices(record.id)).toEqual([NOTICE_1]);
        host.prompt(record.id, 'try again', 'you');
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1, NOTICE_1]);
        endTurn(record.id);
        expect(notices(record.id)).toEqual([NOTICE_1, NOTICE_1]);
    });
});

/**
 * MAIL WAKES THE AGENT (the owner, 2026-10-17: "it seems agents don't wake up from inbox pushes unless I go to their
 * screen"; Tynn #275's open decision, answered). Mail for an agent with NO session used to wait until something else
 * started it — opening its screen did. Now the arrival itself starts it (`wake`, main's open-agent path: a hibernated
 * workspace or the agent cap refuses by name), and the notice is its first turn once ready. Only MAIL wakes: an agent
 * the person stopped is not restarted by its own stop event.
 */
describe.each(['claude', 'codex'] as const)('mail wakes a %s agent', (provider) => {
    let wakes: string[];
    let refuse: string | null;
    beforeEach(() => {
        unwire();
        wakes = [];
        refuse = null;
        unwire = wireInboxPush({
            inbox: services.inbox,
            host,
            reminders: (input) => services.inboxReminders(input),
            settled: (agentId, delivered) => services.inboxNoticeSettled(agentId, delivered),
            cumulative: true,
            wake: (id) => {
                wakes.push(id);
                if (refuse !== null) return false;
                const record = roster.find((r) => r.id === id);
                return record ? host.start(record, dir).ok : false;
            },
        });
    });
    const register = (): AgentRecord => {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider, name: `${provider}-wake` });
        roster.push(record);
        return record;
    };

    it('mailed while NOT RUNNING: Genie starts it, and the notice is its first turn once ready — nobody opens it', async () => {
        const record = register();
        await mail(record.id, 'while you were out');
        expect(wakes).toEqual([record.id]);
        expect(host.runOf(record.id)).not.toBeNull();
        await fakes.get(record.id)!.becomeReady();
        expect(promptsOf(record.id)).toEqual([NOTICE_1]);
    });

    it('CONTROL: a refused wake (asleep, at the cap) leaves the mail waiting, untold; started later, it is told once', async () => {
        const record = register();
        refuse = 'asleep';
        await mail(record.id, 'while you were out');
        expect(wakes).toEqual([record.id]);
        expect(host.runOf(record.id)).toBeNull();
        expect(host.start(record, dir)).toEqual({ ok: true });
        await fakes.get(record.id)!.becomeReady();
        expect(promptsOf(record.id)).toEqual([NOTICE_1]);
    });

    it('only MAIL wakes: stopping an agent does not start it again, and mail for a RUNNING agent starts nothing', async () => {
        const record = register();
        expect(host.start(record, dir)).toEqual({ ok: true });
        await fakes.get(record.id)!.becomeReady();
        await mail(record.id, 'hi');
        expect(wakes).toEqual([]);
        host.stop(record.id);
        expect(wakes).toEqual([]);
        expect(host.runOf(record.id)).toBeNull();
    });
});
