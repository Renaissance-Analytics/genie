import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentId } from '../src/core/identity.js';
import { AUTOMATED_FRAMING, IW_DELIVERIES, MANUAL_FRAMING, tynnProjectIdOf, type IwEvent } from '../src/core/issue-watch.js';
import { wireInboxPush } from '../src/main/inbox-push.js';
import { IssueWatchDelivery } from '../src/main/issue-watch-delivery.js';

/**
 * ISSUEWATCH REACHES THE AGENTS (Tynn #806; the owner: "push updates from github directly to agent workflow like the
 * inbox pushes … the agent mode — manual/auto — influences this push msg").
 *
 * What Tynn's push changed in a project reaches the agents of the Genie workspace linked to that project
 * (project.json `tynn.projectId`), each by its own setting: the kinds it chose, worded for its mode. It goes in through
 * the SAME delivery as mail — Genie's turn into the agent's session when it can take one, told only when that turn ends
 * cleanly, retried otherwise — so it is a visible turn in the agent's Stream, never a hidden rider. `push` wakes a
 * stopped agent as mail does; `next-turn` waits for the agent to be running and never wakes it. Several changes waiting
 * are told as ONE notice.
 */
const PROJECT = 'proj_tynn';
const ev = (kind: IwEvent['kind'], key = 'acme/app:pr:2', title = 'Fix login'): IwEvent => ({ kind, item: { key, kind: 'pr', number: 2, repo: 'acme/app', title, url: 'https://github.com/acme/app/pull/2', updatedAt: null, severity: null } });
const AGENTS = [
    { id: 'a1', name: 'atlas', workspaceId: 'ws_tynn', createdAt: '2026-10-01T00:00:00Z', mode: 'automated' as const },
    { id: 'a2', name: 'wren', workspaceId: 'ws_tynn', createdAt: '2026-10-02T00:00:00Z', mode: 'manual' as const },
    { id: 'a3', name: 'kai', workspaceId: 'ws_other', createdAt: '2026-10-01T00:00:00Z', mode: 'manual' as const },
];
const delivery = (agents: ReadonlyArray<Record<string, unknown>> = AGENTS) => new IssueWatchDelivery({
    agents: () => agents as never,
    workspaceFor: (projectId) => (projectId === PROJECT ? { id: 'ws_tynn', name: 'tynn' } : null),
});
const always = { run: (_id: string) => 1 };

describe('a workspace’s Tynn project, from its project.json', () => {
    it('tynn.projectId, or nothing — never a guess', () => {
        expect(tynnProjectIdOf(JSON.stringify({ name: 'Tynn.ai', tynn: { projectId: '01k95ewy', project: 'Tynn.ai' } }))).toBe('01k95ewy');
        expect(tynnProjectIdOf(JSON.stringify({ name: 'x' }))).toBeNull();
        expect(tynnProjectIdOf(JSON.stringify({ tynn: { projectId: 42 } }))).toBeNull();
        expect(tynnProjectIdOf('not json')).toBeNull();
        expect(tynnProjectIdOf(null)).toBeNull();
    });
});

describe('who is told, and what', () => {
    it('the linked workspace’s agents, each by its own setting: never set, only the first agent (COUNTED)', () => {
        const d = delivery();
        d.onEvents(PROJECT, [ev('pr.new')]);
        const due = d.due(always);
        expect(due.map((x) => x.agentId)).toEqual(['a1']);
        expect(due[0]!.text).toContain('acme/app#2');
        expect(due[0]!.text).toContain('“Fix login”');
        expect(due[0]!.text).toContain('tynn');
    });

    it('worded for its mode: automated told to act, manual told it is for awareness', () => {
        const d = delivery(AGENTS.map((a) => ({ ...a, issueWatch: { delivery: 'push', kinds: ['pr.new'] } })));
        d.onEvents(PROJECT, [ev('pr.new')]);
        const by = Object.fromEntries(d.due(always).map((x) => [x.agentId, x.text]));
        expect(by.a1).toContain(AUTOMATED_FRAMING);
        expect(by.a2).toContain(MANUAL_FRAMING);
        expect(by.a3).toBeUndefined();
    });

    it('only the kinds it chose; a project linked to no workspace reaches nobody', () => {
        const d = delivery([{ ...AGENTS[0]!, issueWatch: { delivery: 'push', kinds: ['security.new'] } }]);
        d.onEvents(PROJECT, [ev('pr.new')]);
        expect(d.due(always)).toEqual([]);
        d.onEvents('proj_unlinked', [ev('security.new')]);
        expect(d.due(always)).toEqual([]);
        // CONTROL: the kind it chose, on the linked project, is told.
        d.onEvents(PROJECT, [ev('security.new')]);
        expect(d.due(always).map((x) => x.agentId)).toEqual(['a1']);
    });

    it('count-only and off are never told here (the count rides imDone)', () => {
        const d = delivery([{ ...AGENTS[0]!, issueWatch: { delivery: 'count', kinds: ['pr.new'] } }, { ...AGENTS[1]!, issueWatch: { delivery: 'off', kinds: ['pr.new'] } }]);
        d.onEvents(PROJECT, [ev('pr.new')]);
        expect(d.due(always)).toEqual([]);
    });
});

describe('told once, as one notice, or told again', () => {
    it('several changes waiting are ONE notice; out until settled; delivered clears, not-delivered tells again', () => {
        const d = delivery();
        d.onEvents(PROJECT, [ev('pr.new')]);
        d.onEvents(PROJECT, [ev('pr.new', 'acme/app:pr:3', 'Add tests')]);
        const first = d.due(always);
        expect(first).toHaveLength(1);
        expect(first[0]!.text).toContain('Fix login');
        expect(first[0]!.text).toContain('Add tests');
        expect(d.due(always)).toEqual([]);
        d.settled('a1', false);
        expect(d.due(always)[0]!.text).toBe(first[0]!.text);
        d.settled('a1', true);
        expect(d.due(always)).toEqual([]);
    });

    it('what arrives while a notice is out waits for the next one', () => {
        const d = delivery();
        d.onEvents(PROJECT, [ev('pr.new')]);
        d.due(always);
        d.onEvents(PROJECT, [ev('pr.new', 'acme/app:pr:4', 'Later')]);
        d.settled('a1', true);
        const next = d.due(always);
        expect(next[0]!.text).toContain('Later');
        expect(next[0]!.text).not.toContain('Fix login');
    });

    it('an agent that can not take a turn now is not told now', () => {
        const d = delivery();
        d.onEvents(PROJECT, [ev('pr.new')]);
        expect(d.due({ run: () => null })).toEqual([]);
        expect(d.due(always)).toHaveLength(1);
    });
});

describe('through the same delivery as mail', () => {
    function fakeHost(running: Set<string>) {
        const listeners = new Set<(id: AgentId) => void>();
        const prompts: Array<{ id: string; text: string; by: string | null }> = [];
        return {
            prompts,
            host: {
                subscribe: (l: (id: AgentId) => void) => { listeners.add(l); return () => listeners.delete(l); },
                promptable: (id: AgentId) => (running.has(id) ? 1 : null),
                runOf: (id: AgentId) => (running.has(id) ? 1 : null),
                turnsEndedThisRun: () => 0,
                probe: () => null,
                prompt: (id: AgentId, text: string, by?: string | null) => { prompts.push({ id, text, by: by ?? null }); return true; },
            },
        };
    }

    it('a running agent gets it as Genie’s turn; push wakes a stopped agent, next-turn never does', () => {
        const d = delivery([
            { ...AGENTS[0]!, issueWatch: { delivery: 'push', kinds: ['pr.new'] } },
            { ...AGENTS[1]!, issueWatch: { delivery: 'next-turn', kinds: ['pr.new'] } },
        ]);
        const h = fakeHost(new Set());
        const woken: string[] = [];
        wireInboxPush({
            inbox: { onSend: (l) => d.onQueued(l) },
            host: h.host,
            reminders: (o) => d.due(o),
            settled: (id, ok) => d.settled(id, ok),
            wake: (id) => { if (!d.wakes(id)) return false; woken.push(id); return false; },
        });
        d.onEvents(PROJECT, [ev('pr.new')]);
        expect(woken).toEqual(['a1']);
        expect(h.prompts).toEqual([]);

        const running = fakeHost(new Set(['a1', 'a2']));
        const d2 = delivery([{ ...AGENTS[0]!, issueWatch: { delivery: 'push', kinds: ['pr.new'] } }]);
        wireInboxPush({ inbox: { onSend: (l) => d2.onQueued(l) }, host: running.host, reminders: (o) => d2.due(o), settled: (id, ok) => d2.settled(id, ok) });
        d2.onEvents(PROJECT, [ev('pr.new')]);
        expect(running.prompts).toHaveLength(1);
        expect(running.prompts[0]).toMatchObject({ id: 'a1', by: 'genie' });
        expect(running.prompts[0]!.text).toContain('IssueWatch');
    });

    it('the deliveries say plainly that push wakes the agent and next-turn does not', () => {
        expect(IW_DELIVERIES.find((d) => d.value === 'push')!.label).toMatch(/wak/);
        expect(IW_DELIVERIES.find((d) => d.value === 'next-turn')!.label).toMatch(/running/);
    });
});

describe('main runs it', () => {
    const src = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('one client listening with the signed-in account’s key and host, one delivery, through the inbox delivery', () => {
        expect(src.match(/new IssueWatchClient\(/g)).toHaveLength(1);
        expect(src.match(/new IssueWatchDelivery\(/g)).toHaveLength(1);
        expect(src).toMatch(/onEvents: \(projectId, events\) => \{[\s\S]{0,300}issueWatchDelivery\.onEvents\(projectId, events\);/);
        expect(src).toMatch(/wireInboxPush\(\{\s*inbox: \{ onSend: \(listener\) => issueWatchDelivery\.onQueued\(listener\) \}/);
        // Over the signed-in SESSION (main/tynn-account.ts), as Genie 1 did — the person's id and session-bound requests;
        // never a bearer token.
        expect(src).toMatch(/tynn: \(\) => \{[\s\S]{0,200}tynnAccount\?\.userId\(\)[\s\S]{0,200}request: \(path, init\) => account\.request\(path, init\)/);
        expect(src).not.toMatch(/credentials: \(\) =>/);
        expect(src).not.toMatch(/tynn_token/);
    });
});
