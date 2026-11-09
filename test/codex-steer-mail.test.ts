import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { deliveryHeader, summarizeInboxPrompt } from './helpers/inbox-delivery.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
import { wireInboxPush } from '../src/main/inbox-push.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import type { NoticeMail } from '../src/core/stream-event.js';

/**
 * CODEX TAKES MAIL MID-TURN, LIKE CLAUDE (Tynn #440). prism-acp 0.38.0's `CodexDriver.steer` adds input to the running
 * native turn. Genie steers the SAME full mail prompt Claude is handed, with a fresh client id per delivery:
 * - `accepted`, then `observed` → the mail is Delivered; nothing is sent again at the turn's end;
 * - `not_delivered` / `turn_ended_unobserved` → held for the turn's end, as before steering existed;
 * - `unknown` → maybe delivered: NEVER sent again (it could arrive twice), and not claimed Delivered either;
 * - a Codex without steering (< 0.163) → held for the turn's end, as before.
 * The fake below is shaped like prism-acp 0.38.0's CodexDriver: `steeringState`, `steer`, `steerState`,
 * `acknowledgeSteer`, and `onSteerUpdate` records.
 */

const NOTICE_1 = deliveryHeader(1);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

type Outcome = 'accepted' | 'not_delivered' | 'unknown';
interface SteerCall { content: unknown; clientId: string }
interface Record_ { steerId: string; threadId: string; turnId: string; kind: string; acceptance: string; final: boolean }
interface Fake {
    prompts: string[];
    events: DriverEvents;
    becomeReady: () => Promise<void>;
    /** `null` = this Codex has no steering API at all (an older prism or CLI). */
    supported: boolean | null;
    outcome: Outcome;
    steers: SteerCall[];
    acknowledged: string[];
    records: Map<string, Record_>;
    /** Report a steer record the way prism-acp does (`onSteerUpdate`) and keep it for `steerState`. */
    update: (clientId: string, kind: string, acceptance?: string) => void;
}
const fakes = new Map<string, Fake>();
/** What the next driver built declares (`Fake.supported`). */
let nextSupported: boolean | null = true;

const driverFor: DriverFor = (record) => {
    if (record.provider !== 'codex') return null;
    const factory: SessionDriverFactory = (options) => {
        let resolve: () => void = () => {};
        const ready = new Promise<void>((r) => { resolve = r; });
        let inFlight = false;
        const fake: Fake = {
            prompts: [],
            events: options.events,
            becomeReady: async () => { resolve(); await ready; await Promise.resolve(); },
            supported: nextSupported,
            outcome: 'accepted',
            steers: [],
            acknowledged: [],
            records: new Map(),
            update: (clientId, kind, acceptance = 'accepted') => {
                const r: Record_ = { steerId: clientId, threadId: 'thr', turnId: 'turn', kind, acceptance,
                    final: kind === 'observed' || kind === 'turn_ended_unobserved' || kind === 'not_delivered' };
                fake.records.set(clientId, r);
                (options.events as { onSteerUpdate?: (u: unknown) => void }).onSteerUpdate?.(r);
            },
        };
        fakes.set(record.id, fake);
        const driver: Record<string, unknown> = {
            start: () => {},
            prompt: (content: unknown) => {
                if (inFlight) throw new Error('Codex turn already in flight');
                inFlight = true;
                fake.prompts.push(String(content));
            },
            kill: () => {},
            cliSessionId: null,
            ready,
        };
        if (fake.supported !== null) {
            Object.defineProperty(driver, 'steeringState', {
                get: () => ({ supported: fake.supported === true, cliVersion: fake.supported ? '0.167.0' : '0.150.0', activeTurnId: inFlight ? 'turn' : null, retainedRecords: fake.records.size, capacity: 128 }),
            });
            driver['steer'] = async (content: unknown, opts: { clientId: string }) => {
                if (fake.supported !== true) throw Object.assign(new Error('steering is not supported'), { code: 'steer_unsupported' });
                fake.steers.push({ content, clientId: opts.clientId });
                const outcome = fake.outcome;
                if (outcome === 'accepted') {
                    fake.records.set(opts.clientId, { steerId: opts.clientId, threadId: 'thr', turnId: 'turn', kind: 'accepted', acceptance: 'accepted', final: false });
                    return { outcome, steerId: opts.clientId, turnId: 'turn' };
                }
                if (outcome === 'not_delivered') {
                    fake.records.set(opts.clientId, { steerId: opts.clientId, threadId: 'thr', turnId: 'turn', kind: 'not_delivered', acceptance: 'not_delivered', final: true });
                    return { outcome, steerId: opts.clientId, reason: 'native_validation_refused' };
                }
                fake.records.set(opts.clientId, { steerId: opts.clientId, threadId: 'thr', turnId: 'turn', kind: 'unknown', acceptance: 'unknown', final: false });
                return { outcome, steerId: opts.clientId, reason: 'reply_timeout' };
            };
            driver['steerState'] = (id: string) => fake.records.get(id) ?? { kind: 'not_known' };
            driver['acknowledgeSteer'] = (id: string) => {
                const r = fake.records.get(id);
                if (!r || !r.final) return false;
                fake.acknowledged.push(id);
                fake.records.delete(id);
                return true;
            };
        }
        fake.events = { ...options.events, onTurnEnd: (o) => { inFlight = false; options.events.onTurnEnd?.(o); } };
        return driver as unknown as ReturnType<SessionDriverFactory>;
    };
    return factory;
};

let dir: string;
let services: ComposedServices;
let host: SessionHost;
let roster: AgentRecord[];
let unwire: () => void;
let delivered: Array<{ agentId: string; mail: readonly NoticeMail[] }>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-codex-steer-'));
    roster = [];
    delivered = [];
    fakes.clear();
    nextSupported = true;
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, docker: async () => ({ stdout: '', exitCode: 1 }), portFree: async () => true });
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
    unwire = wireInboxPush({
        inbox: services.inbox,
        host,
        reminders: (input) => services.inboxReminders(input),
        settled: (agentId, ok) => services.inboxNoticeSettled(agentId, ok),
        delivered: (agentId, mail) => { delivered.push({ agentId, mail }); },
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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const register = (): AgentRecord => {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'codex-steer' });
    roster.push(record);
    return record;
};
/** Started, ready, and in the middle of the person's turn — the busy agent mail used to wait for. */
const startWorking = async (record: AgentRecord, supported: boolean | null = true): Promise<Fake> => {
    nextSupported = supported;
    expect(host.start(record, dir)).toEqual({ ok: true });
    const fake = fakes.get(record.id)!;
    await fake.becomeReady();
    host.prompt(record.id, 'work', 'you');
    return fake;
};
const endTurn = (id: AgentId): void => fakes.get(id)!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
const mail = async (to: AgentId, text: string): Promise<void> => { await services.inbox.send({ from: HUMAN as never, to, text }); await tick(); };
const notices = (fake: Fake): string[] => fake.prompts.map(summarizeInboxPrompt).filter((p) => p.startsWith('AgentInbox delivery:'));
const steeredText = (call: SteerCall): string => {
    expect(Array.isArray(call.content)).toBe(true);
    const blocks = call.content as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    return blocks[0]!.text;
};

describe('a Codex agent takes AgentInbox mail mid-turn by steering (prism-acp 0.38.0)', () => {
    it('SUPPORTED + ACCEPTED: the full mail prompt is steered into the running turn; Delivered once observed; never sent again', async () => {
        const record = register();
        const fake = await startWorking(record);
        await mail(record.id, 'one');
        // Steered now, mid-turn: no second prompt (Codex refuses one), one steer with the full mail prompt.
        expect(fake.prompts).toEqual(['work']);
        expect(fake.steers).toHaveLength(1);
        const call = fake.steers[0]!;
        expect(call.clientId).toMatch(UUID);
        const text = steeredText(call);
        expect(summarizeInboxPrompt(text)).toBe(NOTICE_1);
        expect(text).toContain('one');
        // Accepted is not observed: the card still waits.
        expect(delivered).toEqual([]);
        fake.update(call.clientId, 'observed');
        await tick();
        expect(delivered.map((d) => d.mail.map((m) => m.text))).toEqual([['one']]);
        expect(fake.acknowledged).toEqual([call.clientId]);
        // The turn ends: nothing is sent again, as its own turn or otherwise.
        endTurn(record.id);
        await tick();
        expect(fake.prompts).toEqual(['work']);
        host.prompt(record.id, 'more', 'you');
        endTurn(record.id);
        await tick();
        expect(notices(fake)).toEqual([]);
        expect(fake.steers).toHaveLength(1);
    });

    it('a FRESH client id for every delivery', async () => {
        const record = register();
        const fake = await startWorking(record);
        await mail(record.id, 'one');
        fake.update(fake.steers[0]!.clientId, 'observed');
        await tick();
        endTurn(record.id);
        host.prompt(record.id, 'next', 'you');
        await mail(record.id, 'two');
        expect(fake.steers).toHaveLength(2);
        expect(fake.steers[1]!.clientId).toMatch(UUID);
        expect(fake.steers[1]!.clientId).not.toBe(fake.steers[0]!.clientId);
    });

    it('NOT_DELIVERED: kept queued and sent when the turn ends, as its own turn, exactly once', async () => {
        const record = register();
        const fake = await startWorking(record);
        fake.outcome = 'not_delivered';
        await mail(record.id, 'one');
        expect(fake.steers).toHaveLength(1);
        expect(fake.prompts).toEqual(['work']);
        endTurn(record.id);
        await tick();
        expect(notices(fake)).toEqual([NOTICE_1]);
        endTurn(record.id);
        await tick();
        expect(notices(fake)).toEqual([NOTICE_1]);
        expect(fake.steers).toHaveLength(1);
    });

    it.each(['update before the turn end', 'update after the turn end'] as const)('ACCEPTED then TURN_ENDED_UNOBSERVED (%s): sent at the turn end, exactly once', async (order) => {
        const record = register();
        const fake = await startWorking(record);
        await mail(record.id, 'one');
        const id = fake.steers[0]!.clientId;
        if (order === 'update before the turn end') fake.update(id, 'turn_ended_unobserved');
        endTurn(record.id);
        await tick();
        if (order === 'update after the turn end') {
            // Still pending observation at the turn's end: not sent yet, it may still be seen.
            expect(notices(fake)).toEqual([]);
            fake.update(id, 'turn_ended_unobserved');
            await tick();
        }
        expect(notices(fake)).toEqual([NOTICE_1]);
        expect(fake.acknowledged).toEqual([id]);
        endTurn(record.id);
        await tick();
        expect(notices(fake)).toEqual([NOTICE_1]);
    });

    it('UNKNOWN: maybe delivered — never sent again (no duplicate), and not claimed Delivered', async () => {
        const record = register();
        const fake = await startWorking(record);
        fake.outcome = 'unknown';
        await mail(record.id, 'one');
        expect(fake.steers).toHaveLength(1);
        endTurn(record.id);
        await tick();
        // The end of the turn does not resend it, and nor does the next idle moment or turn.
        expect(fake.prompts).toEqual(['work']);
        host.prompt(record.id, 'more', 'you');
        endTurn(record.id);
        await tick();
        expect(notices(fake)).toEqual([]);
        expect(fake.steers).toHaveLength(1);
        expect(delivered).toEqual([]);
    });

    it.each([['older Codex (steeringState.supported = false)', false], ['no steering API at all', null]] as const)('UNSUPPORTED, %s: held for the turn end, as before', async (_name, supported) => {
        const record = register();
        const fake = await startWorking(record, supported);
        await mail(record.id, 'one');
        expect(fake.steers).toEqual([]);
        expect(fake.prompts).toEqual(['work']);
        endTurn(record.id);
        await tick();
        expect(notices(fake)).toEqual([NOTICE_1]);
        endTurn(record.id);
        await tick();
        expect(notices(fake)).toEqual([NOTICE_1]);
        expect(delivered.map((d) => d.mail.map((m) => m.text))).toEqual([['one']]);
    });
});
