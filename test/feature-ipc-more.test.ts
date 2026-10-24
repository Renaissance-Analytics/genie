import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import type { ToolStatus } from '../src/core/toolchain.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * MORE OF THE FEATURE IPC — the toolchain scan behind its six-hour window, updates judged by the
 * re-probe, the Deck's inline answers routed to the stores, and the person adding knowledge.
 * The prober and updater are PORTS, injected: the tests count calls instead of spawning anything.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let roster: AgentRecord[] = [];
/** An agent on the roster — what the registry hands the composed services. */
const onRoster = (id: string, name: string, workspaceId: string): void => {
    roster.push({ id, workspaceId, provider: 'claude', name, instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null } as never);
};
let probes = 0;
let updates: string[] = [];
let clock = 100 * 3_600_000;
const statuses = (v: string): ToolStatus[] => [{ tool: 'node', installed: v, latest: '22.24.0', tone: v === '22.24.0' ? 'up-to-date' : 'update-available', source: 'nodejs.org index (LTS)' }];
let installed = '22.23.2';
const ports: FeaturePorts = {
    toolchain: {
        probe: async () => { probes += 1; return statuses(installed); },
        update: async (tool) => { updates.push(tool); installed = '22.24.0'; return { kind: 'repaired', from: '22.23.2', to: '22.24.0' }; },
        now: () => clock,
        // The update guard is mandatory now (feature-ipc-toolchain.test.ts): nothing is running here.
        activity: async () => ({ sessions: [], processes: [], engines: [] }),
    },
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-more-'));
    roster = [];
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster });
    probes = 0; updates = []; installed = '22.23.2'; clock = 100 * 3_600_000;
});

afterEach(async () => {
    await services.shutdown();
    // The runtime folder can still be taking a write as shutdown returns (#1140's CI: ENOTEMPTY on .../runtime); the
    // retrying rm the other host suites use (activity-feeds-host, agent-stream-perf) — the teardown, not the assertions.
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('toolchain', () => {
    it('check scans once and records when; a second check inside six hours does NOT scan again; after six hours it does', async () => {
        let snap = await handleFeatureAction(services, { kind: 'toolchain.check' }, state(), ports);
        expect(probes).toBe(1);
        expect(snap.toolchain).toEqual({ tools: statuses('22.23.2'), checkedAt: clock });
        const s2: FeatureState = { ...state(), toolStatuses: snap.toolchain!.tools, toolchainCheckedAt: snap.toolchain!.checkedAt };
        clock += 5 * 3_600_000;
        snap = await handleFeatureAction(services, { kind: 'toolchain.check' }, s2, ports);
        expect(probes).toBe(1);
        clock += 2 * 3_600_000;
        snap = await handleFeatureAction(services, { kind: 'toolchain.check' }, s2, ports);
        expect(probes).toBe(2);
    });

    it('check with force scans regardless of the window', async () => {
        const s: FeatureState = { ...state(), toolStatuses: statuses('22.23.2'), toolchainCheckedAt: clock };
        await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, s, ports);
        expect(probes).toBe(1);
    });

    it('update runs the updater for that tool and re-probes afterwards — the snapshot shows the measured result, not the command’s word', async () => {
        const snap = await handleFeatureAction(services, { kind: 'toolchain.update', tool: 'node' }, state(), ports);
        expect(updates).toEqual(['node']);
        expect(probes).toBe(1);
        expect(snap.toolchain!.tools[0]).toMatchObject({ installed: '22.24.0', tone: 'up-to-date' });
    });

    it('without the toolchain port (no runner wired), check and update leave the section null and say why', async () => {
        await expect(handleFeatureAction(services, { kind: 'toolchain.check' }, state())).rejects.toThrow(/no toolchain runner/);
    });
});

describe('the Deck’s inline answers reach the stores', () => {
    it('a ForceTheQuestion answer removes the question and mails the asker', async () => {
        const a = 'agent_' + 'a'.repeat(32);
        const asked = await services.attention.ask({ agentId: a as never, agentName: 'atlas', workspaceId: 'tynn', questions: [{ header: 'Engine', question: 'Which?', options: [{ label: 'x' }, { label: 'y' }] }] }, { userActive: true });
        const item = services.deckItems().find((i) => i.id === asked.questionId)!;
        // Every agent question is a form now (the owner, 2026-10-14): answered with its selection and a note per question.
        expect(item.answer.kind).toBe('form');
        await handleFeatureAction(services, { kind: 'deck.answerForm', item, selections: [['y']], notes: [''], note: '' }, state());
        expect(services.attention.pending()).toEqual([]);
        expect(services.inbox.unread(a as never)[0]!.text).toContain('y');
    });

    it('a user-list Done marks it done; an unread-dm Mark read commits the cursor; a finish mark read marks it seen', async () => {
        const a = 'agent_' + 'b'.repeat(32);
        onRoster(a, 'atlas', 'tynn');
        const added = await services.attention.lists.add({ list: 'user', workspaceId: 'tynn', agentId: a as never, text: 'rotate the token' });
        await services.inbox.send({ from: a as never, to: 'human', text: 'hi' });
        await services.attention.imDone({ agentId: a as never, agentName: 'atlas', workspacePath: dir, handoff: 'done' });
        const items = services.deckItems();
        expect(items.map((i) => i.source).sort()).toEqual(['finished-handoff', 'unread-dm', 'user-list']);
        for (const item of items) {
            const option = item.source === 'user-list' ? 'done' : item.source === 'unread-dm' ? 'read' : 'seen';
            await handleFeatureAction(services, { kind: 'deck.answer', item, optionId: option }, state());
        }
        expect(services.deckItems()).toEqual([]);
        if (added.kind !== 'added') throw new Error('unreachable');
        expect(services.attention.allUserItems()[0]!.item.done).toBe(true);
    });

    it('a tool approval parked by the queue is a Deck item and Allow resolves it', async () => {
        const verdict = services.approvals.gate({ agentId: 'agent_x' as never, agentName: 'atlas', workspaceId: 'tynn', workspacePath: dir }, 'write', 'ls');
        const item = services.deckItems().find((i) => i.id.startsWith('appr_'))!;
        expect(item).toBeDefined();
        await handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'allow' }, state());
        expect(await verdict).toBe('allowed');
    });

    // beta.33 item 16 — the owner: "I rejected with a note in the rejection but compass did not get the rejection notice".
    it('Deny WITH a note on a Genie approval: the tool gets its verdict, and the note reaches the agent as your message', async () => {
        const verdict = services.approvals.gate({ agentId: 'agent_x' as never, agentName: 'atlas', workspaceId: 'tynn', workspacePath: dir }, 'write', 'npm test');
        const item = services.deckItems().find((i) => i.id.startsWith('appr_'))!;
        const told: string[][] = [];
        await handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'deny', note: 'run it in the background' }, state(), { deliverToAgent: (id, text) => { told.push([id, text]); return true; } });
        expect(await verdict).toBe('denied');
        expect(told).toEqual([['agent_x', `You rejected “${item.title}”: run it in the background`]]);
    });

    it('a note that cannot be delivered is refused BEFORE the answer — never a silent verdict; no note, nothing to deliver', async () => {
        void services.approvals.gate({ agentId: 'agent_x' as never, agentName: 'atlas', workspaceId: 'tynn', workspacePath: dir }, 'write', 'npm test');
        const item = services.deckItems().find((i) => i.id.startsWith('appr_'))!;
        await expect(handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'deny', note: 'why' }, state())).rejects.toThrow(/note cannot reach the agent/);
        expect(services.deckItems().some((i) => i.id === item.id)).toBe(true);
        const told: string[] = [];
        await handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'deny', note: '  ' }, state(), { deliverToAgent: (_id, text) => { told.push(text); return true; } });
        expect(told).toEqual([]);
        expect(services.deckItems().some((i) => i.id === item.id)).toBe(false);
    });

    it('a refused resolution rejects with the reason and changes nothing', async () => {
        const item = services.deckItems();
        expect(item).toEqual([]);
        await expect(handleFeatureAction(services, { kind: 'deck.answer', item: { id: 'q_zzz', source: 'agent-question', agentId: null, agentName: null, workspaceId: null, title: 't', blocking: true, priority: 'normal', at: 0, answer: { kind: 'form', fields: 2 }, forwardedFrom: null }, optionId: 'x' }, state())).rejects.toThrow(/full form/);
    });
});

describe('the person adds knowledge', () => {
    it('knowledge.add files a node as the USER into the chosen scope and the next search finds it', async () => {
        const snap = await handleFeatureAction(services, { kind: 'knowledge.add', title: 'Owner prefers Fancy', body: 'never hand-roll', class: 'profile', scope: { kind: 'system' } }, { ...state(), knowledgeQuery: 'fancy' });
        expect(snap.knowledge.hits!.map((h) => h.title)).toEqual(['Owner prefers Fancy']);
        expect(services.knowledge.get(String(snap.knowledge.hits![0]!.id))!.source).toBe('user');
    });
});
