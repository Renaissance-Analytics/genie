import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attentionTools, type AttentionToolsDeps } from '../src/main/mcp-tools-attention.js';
import { FeedbackStore } from '../src/main/feedback-store.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * THE TWO ATTENTION TOOLS THAT WERE MISSING (§6.3): `openFileForUser` puts a file in front of the
 * person — a path CONFINED to the caller's workspace, so an agent cannot open the host's own files
 * through it — and `submitFeedback` records what the agent thinks of Genie, durably, saying plainly
 * that it stays on this machine until Tynn is connected. Both name the caller from its terminal.
 */

const caller: Caller = { agentId: 'agent_a' as never, agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };
let dir: string;
let feedback: FeedbackStore;
let opened: Array<{ workspaceId: string; path: string; absolutePath: string; line: number | null }>;
let tools: Map<string, (args: Record<string, unknown>, context: { headers: Record<string, string> }) => Promise<{ text: string; isError: boolean }>>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-attention-'));
    feedback = await FeedbackStore.open(dir, () => 1);
    opened = [];
    const deps: AttentionToolsDeps = {
        resolveCaller: (id) => (id === 'term_a' ? caller : null),
        openFile: async (target) => { opened.push(target); return { ok: true }; },
        feedback,
    };
    tools = new Map(attentionTools(deps).map((r) => [r.definition.name, r.handler as never]));
});

afterEach(async () => {
    await feedback.flushed();
    await rm(dir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
    const r = await tools.get(name)!(args, { headers: {} });
    return { ...JSON.parse(r.text), isError: r.isError } as Record<string, unknown>;
};

describe('openFileForUser', () => {
    // genie#922: main is handed the caller's WORKSPACE and the path RELATIVE to it, so it opens Genie's own file panel there
    // — never the absolute path the OS's default app would take (an agent's README opened in Notepad++).
    it('opens a path inside the caller’s workspace (relative or absolute), with an optional line — as that workspace and a relative path', async () => {
        // The confined path is the OS's own absolute form (a drive letter and backslashes on Windows), so compare with resolve().
        expect(await call('openFileForUser', { terminalId: 'term_a', path: 'docs/plan.md', line: 12 })).toMatchObject({ ok: true, path: resolve('/w/tynn', 'docs/plan.md'), isError: false });
        expect(await call('openFileForUser', { terminalId: 'term_a', path: '/w/tynn/src/a.ts' })).toMatchObject({ ok: true, path: resolve('/w/tynn/src/a.ts') });
        expect(opened).toEqual([
            { workspaceId: 'tynn', path: 'docs/plan.md', absolutePath: resolve('/w/tynn', 'docs/plan.md'), line: 12 },
            { workspaceId: 'tynn', path: 'src/a.ts', absolutePath: resolve('/w/tynn/src/a.ts'), line: null },
        ]);
    });

    it('refuses a path outside the workspace by name and opens nothing; refuses an unknown terminal', async () => {
        expect(await call('openFileForUser', { terminalId: 'term_a', path: '../other/secret.txt' })).toMatchObject({ ok: false, error: expect.stringMatching(/outside atlas’s workspace/), isError: true });
        expect(await call('openFileForUser', { terminalId: 'term_a', path: '/etc/hosts' })).toMatchObject({ ok: false, isError: true });
        expect(opened).toEqual([]);
        expect(await call('openFileForUser', { terminalId: 'term_zz', path: 'x' })).toMatchObject({ ok: false, isError: true });
    });
});

describe('submitFeedback', () => {
    it('records the feedback under the caller’s name and says it stays on this machine until Tynn is connected', async () => {
        const r = await call('submitFeedback', { terminalId: 'term_a', kind: 'bug', text: 'the Deck forgets my answer' });
        expect(r).toMatchObject({ ok: true, id: expect.stringMatching(/^fb_/), kept: 'on this machine; Tynn is not connected, so nothing was sent', isError: false });
        expect(feedback.list()).toEqual([expect.objectContaining({ workspaceId: 'tynn', agentName: 'atlas', kind: 'bug', text: 'the Deck forgets my answer', sent: false })]);
    });

    it('refuses empty text and a kind it does not know, in the store’s words', async () => {
        expect(await call('submitFeedback', { terminalId: 'term_a', kind: 'bug', text: '' })).toMatchObject({ ok: false, error: 'feedback needs some text' });
        expect(await call('submitFeedback', { terminalId: 'term_a', kind: 'rant', text: 'x' })).toMatchObject({ ok: false, error: 'feedback kind must be one of bug, idea, praise' });
    });
});
