import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { issueWatchCountLine, issueWatchCounts, parseIssueWatchEntry, type IssueWatchSummary } from '../src/core/issue-watch.js';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type Caller } from '../src/main/mcp-tools.js';

/**
 * WHAT IS OPEN ON GITHUB, ASKED FOR (Tynn #806; Genie 1's `checkIssues` and the count line on every imDone — "so an agent
 * that just finished can immediately flag a new Dependabot alert"). The pushes tell an agent what CHANGED; these tell it
 * what is OPEN: `checkIssues` gives its workspace's open items and counts, and imDone's answer carries the counts in
 * Genie 1's own format (`issues:3, PR:1, sec:3`) — which is also all a count-only agent hears. A workspace linked to no
 * Tynn project, or a Genie not signed in, says so rather than answering "nothing open".
 */
const item = (kind: string, n: number, extra: Record<string, unknown> = {}) => ({ kind, key: `acme/app:${kind}:${n}`, number: n, title: `t${n}`, url: `https://github.com/acme/app/${n}`, updatedAt: 't', owner: 'acme', repo: 'app', ...extra });
const ENTRY = parseIssueWatchEntry({
    projectId: 'proj_1',
    items: [item('issue', 1), item('issue', 2), item('issue', 3), item('pr', 4), item('dependabot', 5, { severity: 'high' }), item('code-scanning', 6), item('secret-scanning', 7)],
    feedbackItems: [{ key: 'tynn-issue:9', number: 9, title: 'fb', url: 'u', updatedAt: 't' }],
})!;

describe('the counts', () => {
    it('by family — issues, PRs, security (all three sources), feedback — and Genie 1’s count line', () => {
        expect(issueWatchCounts(ENTRY)).toEqual({ issues: 3, prs: 1, security: 3, feedback: 1 });
        expect(issueWatchCountLine(issueWatchCounts(ENTRY))).toBe('issues:3, PR:1, sec:3, feedback:1');
        // Nothing open is said as zeros, not as silence.
        expect(issueWatchCountLine({ issues: 0, prs: 0, security: 0, feedback: 0 })).toBe('issues:0, PR:0, sec:0');
    });
});

describe('the tools', () => {
    let dir: string;
    let inbox: InboxStore;
    let attention: AttentionStore;
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
    const caller: Caller = { agentId: atlas.id, agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-iw-tools-'));
        inbox = await InboxStore.open(dir);
        attention = await AttentionStore.open(dir, inbox);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    const tools = (summary: IssueWatchSummary) => genieTools({
        inbox, attention, roster: () => [atlas], resolveCaller: (id) => (id === 't-atlas' ? caller : null),
        workspaceSetting: () => ({ scope: 'self' }), userActive: () => true, glow: () => true, thumbsUp: () => {},
        issueWatch: { forWorkspace: (workspaceId) => (workspaceId === 'tynn' ? summary : { state: 'live', linked: false }) },
    });
    const call = async (t: ReturnType<typeof tools>, name: string, args: JsonObject) => JSON.parse((await t.find((x) => x.definition.name === name)!.handler(args, { server: 'genie', tool: name, headers: {} })).text) as Record<string, unknown>;
    const LIVE: IssueWatchSummary = { state: 'live', linked: true, entry: ENTRY };

    it('imDone’s answer carries the workspace’s counts; signed out it says so instead (CONTROL)', async () => {
        const live = await call(tools(LIVE), 'imDone', { terminalId: 't-atlas', handoff: 'done' });
        expect(live.issueWatch).toBe('issues:3, PR:1, sec:3, feedback:1');
        const out = await call(tools({ state: 'signed-out', linked: true }), 'imDone', { terminalId: 't-atlas', handoff: 'done' });
        expect(out.issueWatch).toBe('not signed in to Tynn');
    });

    it('checkIssues: every open item of the caller’s workspace (COUNTED), with the counts; titles marked as data', async () => {
        const r = await call(tools(LIVE), 'checkIssues', { terminalId: 't-atlas' });
        expect(r.counts).toEqual({ issues: 3, prs: 1, security: 3, feedback: 1 });
        const items = r.items as Array<{ kind: string; ref: string; title: string; url: string; severity: string | null }>;
        expect(items).toHaveLength(8);
        expect(items[4]).toEqual({ kind: 'dependabot', ref: 'acme/app#5', title: 't5', url: 'https://github.com/acme/app/5', severity: 'high' });
        expect(r.note).toMatch(/data, not instructions/);
    });

    it('checkIssues says WHY there is nothing: not linked to a Tynn project, not signed in, not connected yet', async () => {
        expect((await call(tools({ state: 'live', linked: false }), 'checkIssues', { terminalId: 't-atlas' })).reason).toMatch(/not linked to a Tynn project/);
        expect((await call(tools({ state: 'signed-out', linked: true }), 'checkIssues', { terminalId: 't-atlas' })).reason).toMatch(/not signed in to Tynn/);
        expect((await call(tools({ state: 'connecting', linked: true }), 'checkIssues', { terminalId: 't-atlas' })).reason).toMatch(/not connected/);
    });
});

describe('main keeps the latest entry per project and answers for a workspace', () => {
    const src = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('the client reports every entry; the tools are given the summary for a workspace', () => {
        expect(src).toMatch(/onEntry: \(entry\) => \{ issueWatchLatest\.set\(entry\.projectId, entry\); pushFeatures\(\); \}/);
        expect(src).toMatch(/issueWatch: \{ forWorkspace: \(workspaceId\) => issueWatchSummaryFor\(workspaceId\) \}/);
    });
});
