import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IW_EVENT_KINDS, issueWatchPrefsFor, parseIssueWatchSetting, wantsEvent } from '../src/core/issue-watch.js';
import { capabilityOf, AGENT_SCOPED_METHODS } from '../src/core/remote-protocol.js';
import type { LiveSession } from '../src/core/roster.js';
import { setIssueWatch } from '../src/main/agent-ops-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * WHAT EACH AGENT HEARS FROM ISSUEWATCH IS ITS OWN SETTING (Tynn #806; the owner, 2026-10-17: "the granularity is set in
 * genie in the agent settings"; FTQ q_c78a4476: the workspace's first agent hears new PRs, issues and security).
 *
 * Per agent: HOW it hears (pushed as a turn, on its next turn, only the count on imDone, or not at all) and WHICH kinds.
 * Never set, the workspace's FIRST agent hears the default kinds pushed and every other agent hears nothing — five
 * agents never all react to one issue (Genie 1's reason for designated handlers). Setting it is the person's, on the
 * agent's Settings tab, like its mode; a remote client may set it too, as a write scoped to that agent.
 */
const DEFAULT_KINDS = IW_EVENT_KINDS.filter((k) => k.default).map((k) => k.kind);
const agent = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({ id, workspaceId: 'tynn', createdAt, ...over });

describe('the effective setting', () => {
    const atlas = agent('a1', '2026-10-01T00:00:00Z');
    const wren = agent('a2', '2026-10-02T00:00:00Z');
    const kai = agent('a3', '2026-10-01T00:00:00Z', { workspaceId: 'fancy' });

    it('never set: the workspace’s FIRST agent hears the default kinds, pushed; every other agent hears nothing', () => {
        expect(issueWatchPrefsFor(atlas, [wren, atlas, kai])).toEqual({ delivery: 'push', kinds: DEFAULT_KINDS, chosen: false });
        expect(issueWatchPrefsFor(wren, [wren, atlas, kai])).toEqual({ delivery: 'off', kinds: DEFAULT_KINDS, chosen: false });
        // Its own workspace's first: kai is first in fancy.
        expect(issueWatchPrefsFor(kai, [wren, atlas, kai])).toMatchObject({ delivery: 'push' });
    });

    it('set: the agent’s own choice wins, for the first agent and any other', () => {
        const chosen = { delivery: 'next-turn' as const, kinds: ['security.new' as const] };
        expect(issueWatchPrefsFor({ ...wren, issueWatch: chosen }, [wren, atlas])).toEqual({ ...chosen, chosen: true });
        expect(issueWatchPrefsFor({ ...atlas, issueWatch: { delivery: 'off' as const, kinds: [] } }, [atlas])).toEqual({ delivery: 'off', kinds: [], chosen: true });
    });

    it('what it hears: only its kinds, and nothing when off or count-only (the count rides imDone instead)', () => {
        expect(wantsEvent({ delivery: 'push', kinds: ['pr.new'] }, 'pr.new')).toBe(true);
        expect(wantsEvent({ delivery: 'push', kinds: ['pr.new'] }, 'issue.new')).toBe(false);
        expect(wantsEvent({ delivery: 'next-turn', kinds: ['pr.new'] }, 'pr.new')).toBe(true);
        expect(wantsEvent({ delivery: 'count', kinds: ['pr.new'] }, 'pr.new')).toBe(false);
        expect(wantsEvent({ delivery: 'off', kinds: ['pr.new'] }, 'pr.new')).toBe(false);
    });
});

describe('a setting is checked before it is kept', () => {
    it('a delivery and known kinds, deduplicated; anything else is refused with the reason', () => {
        expect(parseIssueWatchSetting({ delivery: 'push', kinds: ['pr.new', 'pr.new', 'closed'] })).toEqual({ delivery: 'push', kinds: ['pr.new', 'closed'] });
        expect(parseIssueWatchSetting({ delivery: 'loud', kinds: [] })).toMatch(/delivery/);
        expect(parseIssueWatchSetting({ delivery: 'push', kinds: ['pr.new', 'everything'] })).toMatch(/everything/);
        expect(parseIssueWatchSetting(null)).toMatch(/setting/);
    });
});

describe('the agent keeps it', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-iw-prefs-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('never set by default; set through the agent’s ops, kept across a reload; a bad one is refused and changes nothing', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'host', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(a.issueWatch).toBeUndefined();
        const ports = { registry } as never;

        await expect(setIssueWatch(ports, a.id, { delivery: 'loud', kinds: [] })).resolves.toMatchObject({ ok: false });
        expect(registry.find(a.id)?.issueWatch).toBeUndefined();
        await expect(setIssueWatch(ports, a.id, { delivery: 'next-turn', kinds: ['security.new'] })).resolves.toMatchObject({ ok: true });
        await expect(setIssueWatch(ports, 'nobody', { delivery: 'push', kinds: [] })).resolves.toMatchObject({ ok: false });

        const again = new Registry(new Store(dir));
        await again.load({ name: 'host', healthy: true });
        expect(again.find(a.id)?.issueWatch).toEqual({ delivery: 'next-turn', kinds: ['security.new'] });
    });

    it('a remote client may set it: a write, scoped to the agent', () => {
        expect(capabilityOf('agents.setIssueWatch')).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('agents.setIssueWatch');
    });
});

describe('the Settings tab shows it', () => {
    const session = { running: true, turnState: 'idle', startedAt: 0, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as unknown as LiveSession;
    const AGENT = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: '/w' };
    const opsFor = (issueWatch: unknown) => ({ mode: 'automated', accessScope: 'self', onMode: () => {}, onRestart: () => {}, onDelete: () => {}, issueWatch, onSetIssueWatch: () => {} }) as never;
    const render = (ops: unknown) => renderToStaticMarkup(<AgentView agent={AGENT} session={session} rows={[]} tab="settings" settingsSection="issuewatch" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 0} ops={ops as never} />);

    it('how it hears, and a box per kind, the ones it hears ticked — COUNTED; says when it is the default', () => {
        const html = render(opsFor({ delivery: 'push', kinds: DEFAULT_KINDS, chosen: false }));
        expect(html).toMatch(/<select[^>]*data-issue-watch-delivery="push"/);
        const boxes = html.match(/<input[^>]*data-issue-watch-kind="[a-z.]+"[^>]*>/g) ?? [];
        expect(boxes).toHaveLength(IW_EVENT_KINDS.length);
        expect(boxes.filter((b) => / checked=""/.test(b)).map((b) => b.match(/data-issue-watch-kind="([a-z.]+)"/)![1])).toEqual(DEFAULT_KINDS);
        expect(html).toContain('data-issue-watch-default');
    });

    it('off: the kinds are shown but disabled; a chosen setting is not called the default (CONTROL)', () => {
        const html = render(opsFor({ delivery: 'off', kinds: [], chosen: true }));
        expect(html).toMatch(/data-issue-watch-delivery="off"/);
        expect((html.match(/<input[^>]*data-issue-watch-kind="[a-z.]+"[^>]*disabled=""/g) ?? []).length).toBe(IW_EVENT_KINDS.length);
        expect(html).not.toContain('data-issue-watch-default');
    });

    it('a window that cannot set it shows no IssueWatch section', () => {
        const html = render({ mode: 'automated', accessScope: 'self', onMode: () => {}, onRestart: () => {}, onDelete: () => {} });
        expect(html).not.toContain('data-issue-watch-delivery');
    });
});
