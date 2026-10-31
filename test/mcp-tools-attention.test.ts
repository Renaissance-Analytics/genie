import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attentionTools, type AttentionToolsDeps } from '../src/main/mcp-tools-attention.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * THE ATTENTION TOOL (§6.3): `openFileForUser` puts a file in front of the person — a path CONFINED to the caller's
 * workspace, so an agent cannot open the host's own files through it — naming the caller from its terminal.
 * `submitFeedback` was removed (the owner, 2026-10-18: "get rid of the submit feedback feature").
 */

const caller: Caller = { agentId: 'agent_a' as never, agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };
let dir: string;
let opened: Array<{ workspaceId: string; path: string; absolutePath: string; line: number | null }>;
let tools: Map<string, (args: Record<string, unknown>, context: { headers: Record<string, string> }) => Promise<{ text: string; isError: boolean }>>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-attention-'));
    opened = [];
    const deps: AttentionToolsDeps = {
        resolveCaller: (id) => (id === 'term_a' ? caller : null),
        openFile: async (target) => { opened.push(target); return { ok: true }; },
    };
    tools = new Map(attentionTools(deps).map((r) => [r.definition.name, r.handler as never]));
});

afterEach(async () => {
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

/** Whether this machine lets an unprivileged process make a FILE symlink (Windows needs Developer Mode or admin). */
const canFileSymlink = (() => {
    const probe = mkdtempSync(join(tmpdir(), 'genie2-symprobe-'));
    try {
        writeFileSync(join(probe, 't'), 'x');
        symlinkSync(join(probe, 't'), join(probe, 'l'), 'file');
        return true;
    } catch {
        return false;
    } finally {
        rmSync(probe, { recursive: true, force: true });
    }
})();

/*
 * genie#1354: the confinement is the SHARED one (workspace-confine.ts), so a link inside the workspace that points out of
 * it is followed and refused — the old check read the path as written only. And a NAME that starts with two dots
 * (`..config`) is a file inside the workspace, not a step up: the old check refused it.
 */
describe('openFileForUser — after links (genie#1354)', () => {
    let ws: string;
    let outside: string;
    let linked: Map<string, (args: Record<string, unknown>, context: { headers: Record<string, string> }) => Promise<{ text: string; isError: boolean }>>;
    const callIn = async (args: Record<string, unknown>) => {
        const r = await linked.get('openFileForUser')!({ terminalId: 'term_l', ...args }, { headers: {} });
        return { ...JSON.parse(r.text), isError: r.isError } as Record<string, unknown>;
    };
    beforeEach(async () => {
        ws = join(dir, 'ws');
        outside = join(dir, 'outside');
        await mkdir(join(ws, 'docs'), { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(ws, 'docs', 'plan.md'), '# plan');
        await writeFile(join(outside, 'secret.txt'), 'not the agent’s');
        const inWs: Caller = { agentId: 'agent_l' as never, agentName: 'lark', workspaceId: 'linked', workspacePath: ws };
        linked = new Map(attentionTools({ resolveCaller: (id) => (id === 'term_l' ? inWs : null), openFile: async (target) => { opened.push(target); return { ok: true }; } }).map((r) => [r.definition.name, r.handler as never]));
    });

    it('a directory link (symlink / junction) inside the workspace that points OUT is refused, and nothing opens', async () => {
        await symlink(outside, join(ws, 'escape'), 'junction');
        expect(await callIn({ path: 'escape/secret.txt' })).toMatchObject({ ok: false, isError: true, error: expect.stringMatching(/outside lark’s workspace/) });
        expect(await callIn({ path: join(ws, 'escape', 'secret.txt') })).toMatchObject({ ok: false, isError: true });
        expect(opened).toEqual([]);
    });

    it.runIf(canFileSymlink)('a FILE symlink inside the workspace that points out is refused', async () => {
        await symlink(join(outside, 'secret.txt'), join(ws, 'innocent.md'), 'file');
        expect(await callIn({ path: 'innocent.md' })).toMatchObject({ ok: false, isError: true });
        expect(opened).toEqual([]);
    });

    it('the refusal never says where the link points', async () => {
        await symlink(outside, join(ws, 'escape'), 'junction');
        const r = await callIn({ path: 'escape/secret.txt' });
        expect(String(r.error)).not.toContain(outside);
    });

    it('POSITIVE CONTROL: a link that stays inside the workspace opens, as the path the agent gave', async () => {
        await symlink(join(ws, 'docs'), join(ws, 'alias'), 'junction');
        expect(await callIn({ path: 'alias/plan.md' })).toMatchObject({ ok: true, isError: false });
        expect(opened).toEqual([{ workspaceId: 'linked', path: 'alias/plan.md', absolutePath: resolve(ws, 'alias/plan.md'), line: null }]);
    });

    it('a name that only STARTS with two dots is inside the workspace: `..config`, `..notes/x.md`', async () => {
        await writeFile(join(ws, '..config'), 'k=v');
        expect(await callIn({ path: '..config' })).toMatchObject({ ok: true, isError: false });
        expect(await callIn({ path: '..notes/x.md' })).toMatchObject({ ok: true, isError: false });
        expect(opened.map((o) => o.path)).toEqual(['..config', '..notes/x.md']);
        // And a real step up is still refused.
        expect(await callIn({ path: '../outside/secret.txt' })).toMatchObject({ ok: false, isError: true });
    });
});

describe('submitFeedback', () => {
    it('is gone: the attention tools are openFileForUser and plan (plan added 2026-10-20 — the Active Plan column had no feed)', () => {
        expect([...tools.keys()]).toEqual(['openFileForUser', 'plan']);
    });
});
