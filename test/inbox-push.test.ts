import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';
import { sessionsDir } from '../src/main/paths.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { wireInboxPush } from '../src/main/inbox-push.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE INBOX PUSH IS GENIE'S, FOR EVERY PROVIDER (B26). When mail lands for an agent, Genie puts the notice into that
 * agent's own session as a turn: at once when it is idle; when it is mid-turn, the moment the turn ends; when it is
 * still starting, the moment it is ready. Exactly once per arrival batch. Nothing here leans on a provider feature —
 * no hook, no MCP notification, no provider interrupt: the drivers below are fakes that can do nothing but take a
 * prompt and report a turn's end, which is all the real ones are asked to do.
 *
 * The owner's timeline (beta.27): a Codex sidecar was started and mailed at once; the mail showed in its chat, the
 * notice did not — it arrived only after the person had typed twice and Codex had answered.
 *
 * The fakes are shaped like prism-acp's real drivers: Codex declares `ready` (its thread is started), Claude does not.
 */

const NOTICE_1 = 'You have 1 unread AgentInbox message; collect it with agentinbox receive.';
const notice = (n: number): string => (n === 1 ? NOTICE_1 : `You have ${n} unread AgentInbox messages; collect them with agentinbox receive.`);

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
const mail = async (to: AgentId, text: string, from: string = HUMAN): Promise<void> => { await services.inbox.send({ from: from as never, to, text }); };
const promptsOf = (id: AgentId): string[] => fakes.get(id)?.prompts ?? [];
const notices = (id: AgentId): string[] => promptsOf(id).filter((p) => p.includes('unread AgentInbox'));

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
        // Two arriving mid-turn are one notice, naming both.
        host.prompt(record.id, 'work', 'you');
        await mail(record.id, 'one');
        await mail(record.id, 'two', other.id);
        endTurn(record.id);
        const notices = host.rowsFor(record.id).map((r) => r.event).filter((e) => e.kind === 'message' && e.speaker === 'peer' && e.peerName === 'genie');
        expect(notices.map((e) => (e.kind === 'message' ? e.text : ''))).toEqual([NOTICE_1, notice(2)]);
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

    it('MID-TURN: held, and delivered the moment the turn ends — once, for everything that arrived', async () => {
        const record = register();
        await startReady(record);
        host.prompt(record.id, 'work', 'you');
        await mail(record.id, 'one');
        await mail(record.id, 'two');
        expect(promptsOf(record.id)).toEqual(['work']);
        endTurn(record.id);
        expect(promptsOf(record.id)).toEqual(['work', notice(2)]);
        // The notice's own turn ending re-announces nothing: the batch was told.
        endTurn(record.id);
        expect(notices(record.id)).toEqual([notice(2)]);
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
