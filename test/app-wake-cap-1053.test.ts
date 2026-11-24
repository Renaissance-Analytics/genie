import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_LIMITS, AppTurnBudget, appSenderId, appWakeCapOf, parseAppWakeCap, type AppMessageMeta, type AppWakeCap } from '../src/core/app-inbox.js';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AGENT_SCOPED_METHODS, REMOTE_METHODS, capabilityOf, type RemoteMethod } from '../src/core/remote-protocol.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { type ComposedServices } from '../src/main/compose.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { appMailPushPorts, wireInboxPush } from '../src/main/inbox-push.js';
import { Registry } from '../src/main/registry.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { composeServices } from './helpers/compose-alone.js';
import { summarizeInboxPrompt } from './helpers/inbox-delivery.js';

/**
 * THE APP WAKE CAP IS THE AGENT'S OWN SETTING (Tynn #1053). Mail from an app (a site, a process or a script of the
 * workspace) gives an agent at most so many turns an hour (genie#1379: 6). The person sets that number per agent, in
 * the agent's settings: a whole number of wakes an hour, 1 or more, or no limit.
 *
 *  - the default stays 6, and an agent nobody set is unchanged (nothing is written to its record);
 *  - a raised cap gives more turns; "unlimited" never holds one, and is a STORED WORD, never a missing value or a zero;
 *  - one agent's cap is its own: another agent's stays what it was;
 *  - a value that is not a whole number of 1 or more, or the word, is refused in words and changes nothing;
 *  - every change is one lifecycle line: the agent's id, the old value and the new one, and no mail;
 *  - it is kept with the agent's record in genie-host, so a host restart keeps it;
 *  - only the host's owner changes it: a share-link guest is refused (test/share-scope-688.test.ts holds that row).
 *
 * The wake tests run the real SessionHost, the real compose (inbox, reminders) and main's own app policy
 * (`appMailPushPorts`); the drivers are fakes that take a prompt and report a turn's end. Fixtures name no person.
 */

const src = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const REFUSAL = /whole number of wakes an hour, 1 or more, or "unlimited" for no limit/;
/** Everything a caller could send that is not a cap: each is refused, and none of them means "no limit". */
const NOT_A_CAP: readonly unknown[] = [0, -1, -6, 1.5, 6.0001, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '', '12', 'none', 'Unlimited', 'no limit', true, false, [], [12], {}];

describe('the value: a whole number of wakes an hour, 1 or more, or the word "unlimited"', () => {
    it.each([1, 6, 7, 12, 500])('%s is a cap', (n) => {
        expect(parseAppWakeCap(n)).toEqual({ ok: true, cap: n });
    });

    it('"unlimited" is a cap of its own', () => {
        expect(parseAppWakeCap('unlimited')).toEqual({ ok: true, cap: 'unlimited' });
    });

    it.each(NOT_A_CAP.map((v) => [JSON.stringify(v) ?? String(v), v] as const))('%s is refused in words', (_name, value) => {
        const parsed = parseAppWakeCap(value);
        expect(parsed.ok).toBe(false);
        expect((parsed as { reason: string }).reason).toMatch(REFUSAL);
    });

    it('a record nobody set reads the default, 6; a set one reads what was set', () => {
        expect(APP_LIMITS.wakeTurns).toBe(6);
        expect(appWakeCapOf(null)).toBe(6);
        expect(appWakeCapOf({})).toBe(6);
        expect(appWakeCapOf({ appWakeCap: 12 })).toBe(12);
        expect(appWakeCapOf({ appWakeCap: 'unlimited' })).toBe('unlimited');
    });

    it('a stored value that is not a cap reads the default: a missing value or a zero is never "no limit"', () => {
        for (const value of NOT_A_CAP) expect(appWakeCapOf({ appWakeCap: value }), JSON.stringify(value) ?? String(value)).toBe(6);
    });
});

describe('the ledger (AppTurnBudget) reads each agent’s own cap', () => {
    const spendUntilHeld = (budget: AppTurnBudget, id: string, tries: number, step: () => void): number => {
        let given = 0;
        for (let i = 0; i < tries; i++) {
            if (budget.waitMs(id) > 0) break;
            budget.spend(id);
            given++;
            step();
        }
        return given;
    };

    it('default 6, a raised cap more, unlimited never held, each agent its own', () => {
        let now = 0;
        const caps: Record<string, AppWakeCap> = { raised: 9, open: 'unlimited' };
        const budget = new AppTurnBudget(() => now, (id) => caps[id] ?? 6);
        const step = (): void => { now += 1_000; };
        expect(spendUntilHeld(budget, 'plain', 50, step)).toBe(6);
        expect(spendUntilHeld(budget, 'raised', 50, step)).toBe(9);
        expect(spendUntilHeld(budget, 'open', 500, step)).toBe(500);
        expect(budget.waitMs('open')).toBe(0);
        expect(budget.waitMs('plain')).toBeGreaterThan(0);
        expect(budget.waitMs('raised')).toBeGreaterThan(0);
    });

    it('a cap raised while an agent is held lets the next turn go at once; lowered, it holds until the window allows', () => {
        let now = 0;
        let cap: AppWakeCap = 6;
        const budget = new AppTurnBudget(() => now, () => cap);
        for (let i = 0; i < 6; i++) { budget.spend('a'); now += 1_000; }
        expect(budget.waitMs('a')).toBeGreaterThan(0);
        cap = 7;
        expect(budget.waitMs('a')).toBe(0);
        cap = 2;
        // Six turns in the window and a cap of 2: allowed again once only one is left in it, the fifth one's hour.
        expect(budget.waitMs('a')).toBe(4_000 + APP_LIMITS.wakeWindowMs - now);
    });
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* The wake itself: the real session host, the real inbox, main's app policy.                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

const site: AppMessageMeta = { source: { kind: 'site', id: 'site_reports', name: 'reports', workspaceId: 'works' }, label: 'site:reports@works', subject: 'report ready', level: 'info' };
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

describe('app mail wakes an idle agent up to ITS cap an hour', () => {
    let dir: string;
    let services: ComposedServices;
    let host: SessionHost;
    let roster: AgentRecord[];
    let unwire: () => void;
    let time: ReturnType<typeof fakeTime>;
    let policy: ReturnType<typeof appMailPushPorts>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-app-wake-cap-'));
        roster = [];
        fakes.clear();
        time = fakeTime();
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, docker: async () => ({ stdout: '', exitCode: 1 }), portFree: async () => true, inboxSession: (id: AgentId) => host?.probe(id) ?? null });
        host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
        // Main's own policy, reading the cap as the host does: from the agent's record, each time it is asked.
        policy = appMailPushPorts({
            modeOf: (id) => roster.find((r) => r.id === id)?.mode,
            capOf: (id) => appWakeCapOf(roster.find((r) => r.id === id)),
            now: time.now,
            schedule: time.schedule,
        });
        unwire = wireInboxPush({
            inbox: services.inbox,
            host,
            reminders: (input) => services.inboxReminders(input),
            settled: (agentId, delivered) => services.inboxNoticeSettled(agentId, delivered),
            cumulative: true,
            ...policy,
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

    const register = (name: string, cap?: unknown): AgentRecord => {
        const base = agentRecord({ id: mintAgentId(), workspaceId: 'works', provider: 'claude', name, mode: 'manual' });
        const record = (cap === undefined ? base : { ...base, appWakeCap: cap }) as AgentRecord;
        roster.push(record);
        return record;
    };
    const setCap = (id: AgentId, cap: AppWakeCap): void => { roster = roster.map((r) => (r.id === id ? { ...r, appWakeCap: cap } as AgentRecord : r)); };
    const endTurn = (id: AgentId): void => fakes.get(id)!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
    const startIdle = (record: AgentRecord): void => {
        expect(host.start(record, dir)).toEqual({ ok: true });
        host.prompt(record.id, 'warm up', 'you');
        endTurn(record.id);
    };
    const notices = (id: AgentId): string[] => (fakes.get(id)?.prompts ?? []).filter((p) => p.startsWith('AgentInbox delivery:')).map(summarizeInboxPrompt);
    const uncollected = (): number => services.signals({ osAgentWorking: false, githubBlocked: false }).uncollectedMail;
    /** One report from the app to an idle agent, a minute after the last: answers whether it opened a turn. */
    const report = async (id: AgentId, n: number): Promise<boolean> => {
        const before = notices(id).length;
        await services.inbox.send({ from: APP_FROM, to: id, text: `report ${n}`, app: site });
        time.advance(COALESCE_MS);
        const woke = notices(id).length === before + 1;
        if (woke) {
            await services.inbox.receive({ participant: id });
            endTurn(id);
        }
        time.advance(30_000);
        return woke;
    };
    /** `count` reports inside one hour: how many opened a turn. */
    const wakesOf = async (id: AgentId, count: number): Promise<number> => {
        let woke = 0;
        for (let i = 0; i < count; i++) if (await report(id, i)) woke++;
        return woke;
    };

    it('DEFAULT UNCHANGED: an agent nobody set gets 6 turns an hour; the rest of its mail waits, unread, and nothing is lost', async () => {
        const agent = register('clerk');
        startIdle(agent);
        expect(await wakesOf(agent.id, 10)).toBe(6);
        expect(uncollected()).toBe(4);
    });

    it('A RAISED CAP WAKES MORE: set to 9, the same ten reports open 9 turns', async () => {
        const agent = register('clerk', 9);
        startIdle(agent);
        expect(await wakesOf(agent.id, 10)).toBe(9);
        expect(uncollected()).toBe(1);
    });

    it('UNLIMITED NEVER REFUSES: every report in the hour opens a turn', async () => {
        const agent = register('clerk', 'unlimited');
        startIdle(agent);
        // 100 reports, 31.5 s apart: all inside one hour, far past any number.
        expect(await wakesOf(agent.id, 100)).toBe(100);
        expect(uncollected()).toBe(0);
    });

    it('ANOTHER AGENT’S CAP IS UNTOUCHED: one raised to 9 and one unlimited leave their neighbour at 6', async () => {
        const raised = register('clerk', 9);
        const open = register('porter', 'unlimited');
        const plain = register('usher');
        for (const a of [raised, open, plain]) startIdle(a);
        expect(await wakesOf(raised.id, 10)).toBe(9);
        expect(await wakesOf(open.id, 10)).toBe(10);
        expect(await wakesOf(plain.id, 10)).toBe(6);
    });

    it('a change applies to the next report, with no restart: held at 6, raised to 8, two more turns', async () => {
        const agent = register('clerk');
        startIdle(agent);
        expect(await wakesOf(agent.id, 7)).toBe(6);
        setCap(agent.id, 8);
        expect(await report(agent.id, 100)).toBe(true);
        expect(await report(agent.id, 101)).toBe(true);
        expect(await report(agent.id, 102)).toBe(false);
    });

    it('a stored value that is not a cap is the default, never "no limit": 0 and null hold at 6', async () => {
        const zero = register('clerk', 0);
        const none = register('porter', null);
        startIdle(zero);
        startIdle(none);
        expect(await wakesOf(zero.id, 10)).toBe(6);
        expect(await wakesOf(none.id, 10)).toBe(6);
    });

    it('a STOPPED automated agent is started by an app’s mail up to its own cap too', () => {
        const plain = { ...register('clerk'), mode: 'automated' as const };
        const raised = { ...register('porter', 8), mode: 'automated' as const };
        const open = { ...register('usher', 'unlimited'), mode: 'automated' as const };
        roster = [plain, raised, open];
        const startedFor = (id: AgentId): boolean => policy.appMail(id, { from: APP_FROM }) === 'push';
        for (const a of [plain, raised, open]) for (let i = 0; i < 6; i++) policy.appBudget.spend(a.id);
        expect(startedFor(plain.id)).toBe(false);
        expect(startedFor(raised.id)).toBe(true);
        policy.appBudget.spend(raised.id);
        policy.appBudget.spend(raised.id);
        expect(startedFor(raised.id)).toBe(false);
        for (let i = 0; i < 200; i++) policy.appBudget.spend(open.id);
        expect(startedFor(open.id)).toBe(true);
    });
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* The setting: kept with the agent's record in genie-host, written over the agents' own protocol, logged.             */
/* ------------------------------------------------------------------------------------------------------------------ */

describe('the setting is the agent’s record’s, in genie-host', () => {
    let dir = '';
    let workspace = '';
    let registry: Registry;
    let clerk: AgentRecord;
    let porter: AgentRecord;
    let lines: string[];

    const IDLE = { running: true, inTurn: false, turnState: 'idle', pendingApproval: null, failure: null };
    function engine(): HostAloneEngine {
        return {
            probe: () => IDLE,
            start: () => ({ ok: true }),
            stop: () => true,
            ended: async () => ({ verified: true, survivors: [], reason: '' }),
            deliverOwed: async () => 0,
            cancel: () => ({ ok: true }),
            resumeLimit: () => {},
            prompt: async () => true,
            promptWith: async () => ({ ok: true }),
            resolvePrompt: async () => ({ ok: true }),
            answerApproval: () => ({ ok: true }),
            subscribe: () => () => {},
            needsNewDriver: () => false,
            notice: () => true,
            ledgerFor: () => [],
            turnsFor: () => 0,
            recentStderrFor: () => [],
            rowsFor: () => [],
            refusals: new Map(),
            modelState: () => null,
            switchModel: () => null,
            settleParked: () => true,
            historyRows: async () => ({ rows: [], truncated: false }),
            toolOutput: async () => ({ ok: true, output: '' }),
            forgetShown: () => {},
            attachment: async () => ({ ok: false, reason: 'n/a' }),
        } as unknown as HostAloneEngine;
    }
    function api(over: Record<string, unknown> = {}) {
        return hostAloneApi({
            hostName: 'bench',
            registry,
            engine,
            cwdFor: () => workspace,
            startRefusal: () => null,
            attention: { finished: () => [], answer: async () => true as never, lists: { done: async () => true } },
            approvals: { resolve: () => true },
            inbox: { unread: () => [], receive: async () => [] as never, involving: () => [] },
            deliverToAgent: async () => true,
            files: {
                children: async () => null,
                open: async (_w: string, path: string) => ({ ok: false as const, path, error: 'n/a' }),
                readBytes: async (_w: string, path: string) => ({ ok: false as const, path, error: 'n/a' }),
                upload: async () => ({ ok: false as const, reason: 'n/a' }),
            },
            models: { get: async () => ({ models: [] }) },
            providerInstalled: () => true,
            settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {}, onChange: () => () => {} },
            terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
            takeOver: () => null,
            headroom: { view: () => ({}), subscribe: () => () => {} },
            lifecycleLog: (line: string) => { lines.push(line); },
            ...over,
        } as unknown as HostAlonePorts);
    }
    const set = (id: string, value: unknown) => api().invoke('agents.setAppWakeCap' as RemoteMethod, [id, value]);
    const reopened = async (): Promise<Registry> => {
        const again = new Registry(new Store(dir));
        await again.load({ name: 'bench', healthy: true });
        return again;
    };
    const stored = async (id: string): Promise<Record<string, unknown>> => {
        const rows = JSON.parse(await readFile(new Store(dir).agentsFile, 'utf8')) as Array<Record<string, unknown>>;
        return rows.find((r) => r['id'] === id)!;
    };

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-app-wake-cap-host-'));
        workspace = resolve(dir, 'ws');
        await mkdir(join(workspace, '.agents', 'clerk'), { recursive: true });
        await writeFile(join(workspace, '.agents', 'clerk', 'AGENT.md'), '# clerk\n');
        lines = [];
        registry = new Registry(new Store(dir));
        await registry.load({ name: 'bench', healthy: true });
        await registry.addWorkspace({ id: 'works', path: workspace });
        clerk = await registry.register({ workspaceId: 'works', provider: 'claude', name: 'clerk' });
        porter = await registry.register({ workspaceId: 'works', provider: 'claude', name: 'porter' });
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('the protocol: one write beside the agent’s other settings, scoped to the agent', () => {
        expect(REMOTE_METHODS).toContain('agents.setAppWakeCap');
        expect(capabilityOf('agents.setAppWakeCap' as RemoteMethod)).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('agents.setAppWakeCap');
    });

    it('a number is kept on the record and read back as the agent’s cap; the host restarted, it is still there', async () => {
        expect(await set(clerk.id, 12)).toMatchObject({ ok: true, record: { id: clerk.id, appWakeCap: 12 } });
        expect(appWakeCapOf(registry.find(clerk.id))).toBe(12);
        const again = await reopened();
        expect(again.find(clerk.id)).toMatchObject({ appWakeCap: 12 });
        // What the restarted host's mail wake reads: twelve turns, then held.
        const budget = new AppTurnBudget(() => 0, (id) => appWakeCapOf(again.find(id as AgentId)));
        for (let i = 0; i < 12; i++) { expect(budget.waitMs(clerk.id)).toBe(0); budget.spend(clerk.id); }
        expect(budget.waitMs(clerk.id)).toBeGreaterThan(0);
    });

    it('"no limit" is the STORED WORD "unlimited", never a missing value or a zero; it survives a host restart', async () => {
        expect(await set(clerk.id, 'unlimited')).toMatchObject({ ok: true, record: { appWakeCap: 'unlimited' } });
        expect((await stored(clerk.id))['appWakeCap']).toBe('unlimited');
        const again = await reopened();
        expect(appWakeCapOf(again.find(clerk.id))).toBe('unlimited');
    });

    it('EXISTING AGENTS ARE UNCHANGED: an agent nobody set has no such field, before and after its neighbour is set', async () => {
        expect('appWakeCap' in (await stored(porter.id))).toBe(false);
        await set(clerk.id, 30);
        expect('appWakeCap' in (await stored(porter.id))).toBe(false);
        expect(appWakeCapOf((await reopened()).find(porter.id))).toBe(6);
        expect(appWakeCapOf((await reopened()).find(clerk.id))).toBe(30);
    });

    it.each(NOT_A_CAP.map((v) => [JSON.stringify(v) ?? String(v), v] as const))('AN INVALID VALUE IS REFUSED IN WORDS: %s changes nothing and logs nothing', async (_name, value) => {
        await set(clerk.id, 12);
        lines.length = 0;
        const answer = await set(clerk.id, value) as { ok: boolean; reason?: string };
        expect(answer.ok).toBe(false);
        expect(answer.reason).toMatch(REFUSAL);
        expect((await stored(clerk.id))['appWakeCap']).toBe(12);
        expect(lines).toEqual([]);
    });

    it('an agent that does not exist is refused, and nothing is logged', async () => {
        expect(await set('agent_nobody', 12)).toMatchObject({ ok: false });
        expect(await api().invoke('agents.setAppWakeCap' as RemoteMethod, [null, 12])).toMatchObject({ ok: false });
        expect(lines).toEqual([]);
    });

    it('EVERY CHANGE IS LOGGED: one lifecycle line with the agent’s id, the old value and the new one, and nothing else', async () => {
        await set(clerk.id, 12);
        await set(clerk.id, 'unlimited');
        await set(clerk.id, 6);
        expect(lines).toEqual([
            `agent setting agent=${clerk.id} appWakeCap old=6 new=12`,
            `agent setting agent=${clerk.id} appWakeCap old=12 new=unlimited`,
            `agent setting agent=${clerk.id} appWakeCap old=unlimited new=6`,
        ]);
    });

    it('a value equal to the one in force is not a change: answered, nothing written over it, nothing logged', async () => {
        expect(await set(porter.id, 6)).toMatchObject({ ok: true });
        expect('appWakeCap' in (await stored(porter.id))).toBe(false);
        await set(clerk.id, 12);
        lines.length = 0;
        expect(await set(clerk.id, 12)).toMatchObject({ ok: true, record: { appWakeCap: 12 } });
        expect(lines).toEqual([]);
    });

    it('a host with no log still keeps the setting (the log is never why a write fails)', async () => {
        expect(await api({ lifecycleLog: undefined }).invoke('agents.setAppWakeCap' as RemoteMethod, [clerk.id, 12])).toMatchObject({ ok: true });
        expect((await stored(clerk.id))['appWakeCap']).toBe(12);
    });

    it('the agent’s detail carries it to every window: 6 for an agent nobody set, then what was set', async () => {
        const detail = async (id: string) => (await api().invoke('agentDetail', [id]) as { agent: { appWakeCap?: unknown } }).agent.appWakeCap;
        expect(await detail(porter.id)).toBe(6);
        await set(clerk.id, 'unlimited');
        expect(await detail(clerk.id)).toBe('unlimited');
        await set(clerk.id, 40);
        expect(await detail(clerk.id)).toBe(40);
    });

    // "A write refreshes what clients see" is held by test/host-alone-agent-ops.test.ts ("every write in the adapter
    // refreshes what clients see"), which names this method. A row here that listened for a snapshot event stayed green
    // with the refresh taken out (break probe P14, run 1124-042811-0325da): the registry's own write announces one too.
});

describe('the wiring (source guards)', () => {
    it('genie-host’s mail wake reads the cap from the agent’s record each time it is asked', () => {
        const code = src('src/main/host-mail-wake.ts');
        const call = code.slice(code.indexOf('...appMailPushPorts({'));
        expect(call.slice(0, call.indexOf('}),'))).toContain('capOf: (agentId) => appWakeCapOf(p.registry.find(agentId))');
    });

    it('genie-host hands its lifecycle log to the agents’ operations', () => {
        const code = src('src/main/genie-host.ts');
        const call = code.slice(code.indexOf('phoneApi = hostAloneApi({'));
        expect(call.slice(0, call.indexOf('\n    });'))).toMatch(/^\s*lifecycleLog,$/m);
        expect(src('src/main/host-alone-api.ts')).toMatch(/log: ports\.lifecycleLog/);
    });

    it('the window holds none of it: both bridges pass the call on, and the view reads the agent’s detail', () => {
        expect(src('src/renderer/remote-bridge.ts')).toContain("setAppWakeCap: (agentId, cap) => answer('agents.setAppWakeCap', agentId, cap)");
        expect(src('src/renderer/local-session.ts')).toContain('setAppWakeCap: (id, cap) => requestAgent((agents) => agents.setAppWakeCap(id, cap))');
        const app = src('src/renderer/App.tsx');
        expect(app).toMatch(/appWakeCap: detail\?\.agent\.appWakeCap \?\? 6/);
        expect(app).toMatch(/onSetAppWakeCap: \(cap\) =>/);
        expect(src('src/main/preload.ts')).not.toContain('app-wake-cap');
        expect(src('src/main/main.ts')).not.toContain('setAppWakeCap');
    });

    it('the guide agents read says the number is the default and the person’s to set', () => {
        expect(src('src/main/agent-skills.ts')).toContain("at most 6 turns an hour unless the person set another number, or no limit, in the agent's settings");
    });
});
