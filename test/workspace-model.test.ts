import { describe, expect, it } from 'vitest';
import {
    classifyFolder,
    diagnoseAgent,
    hibernate,
    planAdd,
    stampSchema,
    type FolderFacts,
} from '../src/core/workspace-model.js';

/**
 * WORKSPACES AND AGENTS (§6.1, §6.2) — the pure half of what was still missing: folder
 * classification and the add-workspace PLAN shown before anything is written; schema stamping that
 * refuses to overwrite a newer revision; the hibernate sequence; and `diagnose`, which names a
 * CAUSE and the repair that fits — and knows that `starting` and `dormant` are not faults.
 */

const facts = (over: Partial<FolderFacts>): FolderFacts => ({ exists: true, entries: [], ...over });

describe('classifying a folder', () => {
    it('empty → empty; a .git with code → simple repo; an .agi marker without project.json → pre-init; project.json + repos/ + .ai/ → full envelope', () => {
        expect(classifyFolder(facts({ entries: [] }))).toBe('empty');
        expect(classifyFolder(facts({ entries: ['.git', 'src', 'package.json'] }))).toBe('simple-repo');
        expect(classifyFolder(facts({ entries: ['.agi', 'repos'] }))).toBe('pre-init');
        expect(classifyFolder(facts({ entries: ['project.json', 'repos', '.ai', '.gitmodules'] }))).toBe('full-envelope');
    });

    it('a folder that does not exist, or has files but no repo and no envelope, is `other` — never guessed into a repo', () => {
        expect(classifyFolder(facts({ exists: false }))).toBe('missing');
        expect(classifyFolder(facts({ entries: ['notes.txt', 'photo.jpg'] }))).toBe('other');
    });
});

describe('the add-workspace plan — shown BEFORE anything is written', () => {
    it('an empty folder gets the full scaffold; a simple repo is wrapped with itself as the host repo; a full envelope needs only registration', () => {
        expect(planAdd('empty', '/w/new').map((s) => s.action)).toEqual(['write project.json', 'create repos/', 'create .ai/', 'create sandbox/ (gitignored)', 'create .trash/ (gitignored)', 'git init', 'register in Genie']);
        const wrap = planAdd('simple-repo', '/w/app');
        expect(wrap.map((s) => s.action)).toEqual(['write project.json (host repo: this folder)', 'create .ai/', 'create sandbox/ (gitignored)', 'create .trash/ (gitignored)', 'register in Genie']);
        expect(wrap.every((s) => s.writes === (s.action !== 'register in Genie'))).toBe(true);
        expect(planAdd('full-envelope', '/w/env')).toEqual([{ action: 'register in Genie', path: '/w/env', writes: false }]);
    });

    it('a missing folder and an `other` folder have NO plan — they are refused with the reason', () => {
        expect(() => planAdd('missing', '/w/x')).toThrow(/does not exist/);
        expect(() => planAdd('other', '/w/x')).toThrow(/neither a repo nor an envelope/);
    });
});

describe('schema stamping — with a backup, and a refusal to overwrite a newer revision', () => {
    const current = { $schema: 'https://schemas.civicognita.org/agi/project/1.2.0.json', name: 'tynn' };

    it('stamps an older or unstamped manifest to the pinned revision and names the backup it will write', () => {
        expect(stampSchema({ name: 'tynn' }, '1.2.0')).toEqual({ ok: true, manifest: { $schema: 'https://schemas.civicognita.org/agi/project/1.2.0.json', name: 'tynn' }, backup: 'project.json.pre-schema-1.2.0.bak', from: null });
        expect(stampSchema({ ...current, $schema: 'https://schemas.civicognita.org/agi/project/1.1.0.json' }, '1.2.0')).toMatchObject({ ok: true, from: '1.1.0' });
    });

    it('REFUSES to overwrite a newer revision, and leaves a same-revision manifest untouched', () => {
        expect(stampSchema({ ...current, $schema: 'https://schemas.civicognita.org/agi/project/1.3.0.json' }, '1.2.0')).toEqual({ ok: false, reason: 'project.json declares schema 1.3.0, newer than the 1.2.0 this Genie writes; not touching it' });
        expect(stampSchema(current, '1.2.0')).toEqual({ ok: true, manifest: current, backup: null, from: '1.2.0' });
    });
});

describe('hibernate — an ordered shutdown that stays asleep', () => {
    it('asks every agent for a handoff with a bounded wait, marks the workspace asleep so nothing may start, stops everything, and agents leave the inbox', () => {
        const plan = hibernate({ workspaceId: 'tynn', agents: ['agent_a', 'agent_b'], terminals: ['term_1'], processes: ['proc_q'], handoffWaitMs: 30_000 });
        expect(plan.steps.map((s) => s.kind)).toEqual(['ask-handoff', 'mark-asleep', 'stop-agents', 'stop-terminals', 'stop-processes', 'leave-inbox']);
        expect(plan.steps[0]).toEqual({ kind: 'ask-handoff', agents: ['agent_a', 'agent_b'], waitMs: 30_000 });
        // Asleep comes BEFORE stopping: nothing may start while the rest is torn down.
        expect(plan.steps.findIndex((s) => s.kind === 'mark-asleep')).toBeLessThan(plan.steps.findIndex((s) => s.kind === 'stop-agents'));
        expect(plan.staysAsleepThrough).toEqual(['restart', 'upgrade']);
    });

    it('a workspace with nothing running still marks asleep — hibernate is a STATE, not just a teardown', () => {
        const plan = hibernate({ workspaceId: 'tynn', agents: [], terminals: [], processes: [], handoffWaitMs: 30_000 });
        expect(plan.steps.map((s) => s.kind)).toEqual(['mark-asleep']);
    });
});

describe('diagnose — read-only; names a CAUSE and the repair that fits', () => {
    it('a registered-never-started agent is `dormant` and a just-started one is `starting`; NEITHER is a fault', () => {
        expect(diagnoseAgent({ threadId: null, lastUsedAt: null, session: null, providerInstalled: true, signedIn: true })).toEqual({ state: 'dormant', fault: false, cause: 'registered, never started', repair: null });
        expect(diagnoseAgent({ threadId: null, lastUsedAt: null, session: { state: 'starting', sinceMs: 4_000 }, providerInstalled: true, signedIn: true })).toEqual({ state: 'starting', fault: false, cause: 'started 4 s ago, no turn yet', repair: null });
    });

    it('a missing provider → install it; not signed in → sign in; a crashed session → restart (fresh if the thread cannot resume)', () => {
        expect(diagnoseAgent({ threadId: 't', lastUsedAt: 'x', session: null, providerInstalled: false, signedIn: false })).toMatchObject({ state: 'broken', fault: true, cause: 'claude is not installed', repair: { action: 'install-provider' } });
        expect(diagnoseAgent({ threadId: 't', lastUsedAt: 'x', session: null, providerInstalled: true, signedIn: false })).toMatchObject({ fault: true, cause: 'claude is not signed in', repair: { action: 'sign-in' } });
        expect(diagnoseAgent({ threadId: 't', lastUsedAt: 'x', session: { state: 'crashed', exitCode: 1 }, providerInstalled: true, signedIn: true })).toMatchObject({ fault: true, cause: 'the provider process exited with code 1', repair: { action: 'restart-graceful' } });
        expect(diagnoseAgent({ threadId: 'bad id!', lastUsedAt: 'x', session: { state: 'crashed', exitCode: 1 }, providerInstalled: true, signedIn: true })).toMatchObject({ repair: { action: 'restart-fresh', reason: expect.stringMatching(/thread/) } });
    });

    it('a running agent is `healthy` with no repair — diagnose never invents a problem', () => {
        expect(diagnoseAgent({ threadId: 't', lastUsedAt: 'x', session: { state: 'running' }, providerInstalled: true, signedIn: true })).toEqual({ state: 'healthy', fault: false, cause: null, repair: null });
    });
});
