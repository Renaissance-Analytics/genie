import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDelivery, appSenderId, type AppMessageMeta } from '../src/core/app-inbox.js';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { isAppSender } from '../src/core/app-inbox.js';
import { reminderText } from '../src/core/inbox-reminders.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { wireInboxPush, type InboxPushPorts } from '../src/main/inbox-push.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * INBOX MAIL REACHES THE AGENT WITHOUT THE PERSON TYPING (genie#1379; the owner on beta.53, 2026-10-31: "I see it show
 * up in the chat, but the agent doesn't get the nudge unless I send something … Users should not have to drive chat for
 * agents to get notifications they need"). Replaces #1350's D1 as built, where a MANUAL agent was given no turn of its
 * own for an app's message and heard of it only after the person's next turn.
 *
 *  - IDLE: a turn promptly — after a short coalescing window, so a burst is ONE turn that names them all;
 *  - BUSY: told when its current turn ends (a follow-up turn), never dropped, never waiting on the person;
 *  - THE APP WAKE CAP: an app can cause only so many turns per agent per window; past it the mail waits for the window,
 *    then one turn — still with nobody typing;
 *  - STOPPED / FAILED: an app's message does not start a manual agent; it waits, and shows as uncollected.
 *
 * Real SessionHost, real compose (inbox, reminders), main's app policy; the drivers are fakes that can only take a
 * prompt and report a turn's end — which is all the real ones are asked to do.
 */

const site: AppMessageMeta = { source: { kind: 'site', id: 'site_flabs', name: 'flabs', workspaceId: 'fancy' }, label: 'site:flabs@fancy', subject: 'petition queued', level: 'info' };
const APP_FROM = appSenderId(site.source);
const COALESCE_MS = 1500;

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

interface Fake { prompts: string[]; events: DriverEvents }
const fakes = new Map<string, Fake>();
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        const fake: Fake = { prompts: [], events: options.events };
        fakes.set(record.id, fake);
        return { start: () => {}, prompt: (content: unknown) => { fake.prompts.push(String(content)); }, kill: () => {}, cliSessionId: null };
    };
    return factory;
};

/** A clock and a timer queue the test drives: nothing fires until `advance` passes its due time. */
function fakeTime() {
    let now = 1_000_000;
    let timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    return {
        now: () => now,
        schedule: (fn: () => void, ms: number): (() => void) => {
            const t = { at: now + ms, fn, live: true };
            timers.push(t);
            return () => { t.live = false; };
        },
        advance: (ms: number): void => {
            const until = now + ms;
            for (;;) {
                const next = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
                if (!next) break;
                now = next.at;
                next.live = false;
                next.fn();
            }
            now = until;
            timers = timers.filter((t) => t.live);
        },
    };
}

let dir: string;
let services: ComposedServices;
let host: SessionHost;
let roster: AgentRecord[];
let unwire: () => void;
let time: ReturnType<typeof fakeTime>;
let woken: string[];
/** The app wake cap's ledger as main keeps it: app-caused turns per agent, by time. */
let appTurns: Map<string, number[]>;
const CAP = { turns: 3, windowMs: 60 * 60_000 };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-inbox-wake-'));
    roster = [];
    fakes.clear();
    time = fakeTime();
    woken = [];
    appTurns = new Map();
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, docker: async () => ({ stdout: '', exitCode: 1 }), portFree: async () => true });
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
    const appBudget: NonNullable<InboxPushPorts['appBudget']> = {
        waitMs: (id) => {
            const recent = (appTurns.get(id) ?? []).filter((at) => time.now() - at < CAP.windowMs);
            return recent.length < CAP.turns ? 0 : recent[0]! + CAP.windowMs - time.now();
        },
        spend: (id) => { appTurns.set(id, [...(appTurns.get(id) ?? []), time.now()]); },
    };
    unwire = wireInboxPush({
        inbox: services.inbox,
        host,
        reminders: (input) => services.inboxReminders(input),
        settled: (agentId, delivered) => services.inboxNoticeSettled(agentId, delivered),
        wake: (id) => {
            woken.push(id);
            const record = roster.find((r) => r.id === id);
            return record ? host.start(record, dir).ok : false;
        },
        appMail: (to, message) => (isAppSender(message.from) ? appDelivery(roster.find((r) => r.id === to)?.mode ?? 'manual', appBudget.waitMs(to) === 0) : null),
        appBudget,
        schedule: time.schedule,
        coalesceMs: COALESCE_MS,
    });
});
afterEach(async () => {
    unwire();
    host.stopAll();
    await host.settled();
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const register = (mode: AgentRecord['mode'], name: string): AgentRecord => {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'claude', name, mode });
    roster.push(record);
    return record;
};
const endTurn = (id: AgentId): void => fakes.get(id)!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
/** Started, and one turn of the person's run and ended: idle by every reading — the state the owner's fancy was in. */
const startIdle = (record: AgentRecord): void => {
    expect(host.start(record, dir)).toEqual({ ok: true });
    host.prompt(record.id, 'warm up', 'you');
    endTurn(record.id);
};
const appMail = async (to: AgentId, text = 'petition #42 queued'): Promise<void> => { await services.inbox.send({ from: APP_FROM, to, text, app: site }); };
const agentMail = async (from: AgentId, to: AgentId, text = 'hello'): Promise<void> => { await services.inbox.send({ from, to, text }); };
const notices = (id: AgentId): string[] => (fakes.get(id)?.prompts ?? []).filter((p) => p.includes('unread AgentInbox'));
const uncollected = (): number => services.signals({ osAgentWorking: false, githubBlocked: false }).uncollectedMail;

describe.each(['manual', 'automated'] as const)('an IDLE %s agent', (mode) => {
    it('gets a turn for an APP’s message — with no person message (the owner’s fancy, beta.53)', async () => {
        const agent = register(mode, 'fancy');
        startIdle(agent);
        await appMail(agent.id);
        time.advance(COALESCE_MS);
        expect(notices(agent.id)).toEqual([reminderText(1, 1)]);
    });

    it('gets a turn for ANOTHER AGENT’s message — with no person message', async () => {
        const agent = register(mode, 'fancy');
        const peer = register('manual', 'wren');
        startIdle(agent);
        await agentMail(peer.id, agent.id);
        time.advance(COALESCE_MS);
        expect(notices(agent.id)).toEqual([reminderText(1)]);
    });

    it('a BURST is ONE turn that names them all — not one turn per message', async () => {
        const agent = register(mode, 'fancy');
        const peer = register('manual', 'wren');
        startIdle(agent);
        await appMail(agent.id, 'one');
        time.advance(200);
        await appMail(agent.id, 'two');
        time.advance(200);
        await agentMail(peer.id, agent.id, 'three');
        time.advance(200);
        await appMail(agent.id, 'four');
        expect(notices(agent.id)).toEqual([]);
        time.advance(COALESCE_MS);
        expect(notices(agent.id)).toEqual([reminderText(4, 3)]);
        // Its turn ends with them collected: nothing more.
        await services.inbox.receive({ participant: agent.id });
        endTurn(agent.id);
        time.advance(COALESCE_MS);
        expect(notices(agent.id)).toEqual([reminderText(4, 3)]);
    });
});

describe('a BUSY agent', () => {
    it('is not interrupted; told when its turn ends, as a follow-up turn — nobody types again', async () => {
        const agent = register('manual', 'fancy');
        startIdle(agent);
        host.prompt(agent.id, 'the person’s task', 'you');
        await appMail(agent.id);
        time.advance(COALESCE_MS * 4);
        expect(notices(agent.id)).toEqual([]);
        endTurn(agent.id);
        time.advance(COALESCE_MS);
        expect(notices(agent.id)).toEqual([reminderText(1, 1)]);
    });
});

describe('the app wake cap', () => {
    it('holds: past the cap an app causes no turn; the mail waits for the window, then ONE turn, with nobody typing', async () => {
        const agent = register('manual', 'fancy');
        startIdle(agent);
        for (let i = 0; i < CAP.turns; i++) {
            await appMail(agent.id, `report ${i}`);
            time.advance(COALESCE_MS);
            await services.inbox.receive({ participant: agent.id });
            endTurn(agent.id);
            time.advance(60_000);
        }
        expect(notices(agent.id)).toHaveLength(CAP.turns);
        // Over the cap: two more reports are stored and wait.
        await appMail(agent.id, 'over 1');
        await appMail(agent.id, 'over 2');
        time.advance(10 * 60_000);
        expect(notices(agent.id)).toHaveLength(CAP.turns);
        expect(uncollected()).toBe(2);
        // The window reopens: one turn for both.
        time.advance(CAP.windowMs);
        expect(notices(agent.id)).toHaveLength(CAP.turns + 1);
        expect(notices(agent.id).at(-1)).toBe(reminderText(2, 2));
    });

    it('does not hold back ANOTHER AGENT’s mail: an agent’s message still gets its turn', async () => {
        const agent = register('manual', 'fancy');
        const peer = register('manual', 'wren');
        startIdle(agent);
        appTurns.set(agent.id, Array.from({ length: CAP.turns }, () => time.now()));
        await agentMail(peer.id, agent.id);
        time.advance(COALESCE_MS);
        expect(notices(agent.id)).toEqual([reminderText(1)]);
    });
});

describe('a STOPPED or FAILED agent', () => {
    it('stopped (manual): an app’s message does not start it; it waits, shown as uncollected', async () => {
        const agent = register('manual', 'fancy');
        await appMail(agent.id);
        time.advance(COALESCE_MS * 4);
        expect(woken).toEqual([]);
        expect(host.runOf(agent.id)).toBeNull();
        expect(uncollected()).toBe(1);
        // Started by the person later: told once, at once.
        expect(host.start(agent, dir)).toEqual({ ok: true });
        expect(notices(agent.id)).toEqual([reminderText(1, 1)]);
    });

    it('stopped (automated) past the app wake cap: not started; it waits, shown as uncollected', async () => {
        const agent = register('automated', 'clerk');
        appTurns.set(agent.id, Array.from({ length: CAP.turns }, () => time.now()));
        await appMail(agent.id);
        time.advance(COALESCE_MS);
        expect(woken).toEqual([]);
        expect(host.runOf(agent.id)).toBeNull();
        expect(uncollected()).toBe(1);
    });

    it('failed: given no turn and not restarted; its mail waits, shown as uncollected', async () => {
        const agent = register('automated', 'clerk');
        startIdle(agent);
        host.prompt(agent.id, 'the person’s task', 'you');
        fakes.get(agent.id)!.events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'stream closed' });
        await appMail(agent.id);
        time.advance(COALESCE_MS * 4);
        expect(notices(agent.id)).toEqual([]);
        expect(woken).toEqual([]);
        expect(uncollected()).toBe(1);
    });
});
