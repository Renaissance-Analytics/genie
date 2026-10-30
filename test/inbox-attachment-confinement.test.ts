import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type Caller, type GenieToolsDeps, type Registration } from '../src/main/mcp-tools.js';
import { insideRoot } from '../src/main/workspace-confine.js';

/**
 * AGENTINBOX ATTACHMENTS STAY INSIDE THE CALLER'S WORKSPACE (genie#1347).
 *
 * Genie 1 (v0.7.0-beta.342) read every `send` attachment and wrote every `saveAttachment` target through
 * `guardedResolve(ws.path, …)` (main/agentinbox/attachments.ts `confine`, main/files/ipc.ts): an agent could hand on
 * only its own workspace's files and land a received file only inside its own workspace. Genie 2's store read and
 * wrote any path. These tests hold the confinement — lexically (`..`, absolute elsewhere, another drive, UNC), and
 * after links are followed (a symlink or junction inside the workspace that points out of it) — at the STORE, so no
 * caller can skip it, and through the agentinbox tool, which is how an agent reaches it.
 *
 * Fixture roots come from `resolve`, never `join('/', …)`: a joined root has no drive on Windows.
 */

/** A directory link that any user may make: a junction on Windows (no privilege needed), a symlink elsewhere. */
const dirLink = (target: string, link: string) => symlink(target, link, 'junction');

/** Whether this machine lets an unprivileged process make a FILE symlink (Windows needs Developer Mode or admin). */
const canFileSymlink = (() => {
    const probe = mkdtempSync(path.join(tmpdir(), 'genie2-symprobe-'));
    try {
        writeFileSync(path.join(probe, 't'), 'x');
        symlinkSync(path.join(probe, 't'), path.join(probe, 'l'), 'file');
        return true;
    } catch {
        return false;
    } finally {
        rmSync(probe, { recursive: true, force: true });
    }
})();

describe('insideRoot — the lexical half, on both platforms’ path rules', () => {
    it('POSIX: inside resolves; `..`, absolute elsewhere and a sibling sharing the prefix are refused', () => {
        const p = path.posix;
        expect(insideRoot('/home/u/ws', 'notes/a.md', p)).toBe('/home/u/ws/notes/a.md');
        expect(insideRoot('/home/u/ws', '/home/u/ws/a.md', p)).toBe('/home/u/ws/a.md');
        expect(insideRoot('/home/u/ws', 'sub/../a.md', p)).toBe('/home/u/ws/a.md');
        expect(insideRoot('/home/u/ws', '../other/secret', p)).toBeNull();
        expect(insideRoot('/home/u/ws', 'a/../../x', p)).toBeNull();
        expect(insideRoot('/home/u/ws', '/home/u/.ssh/id_rsa', p)).toBeNull();
        expect(insideRoot('/home/u/ws', '/home/u/ws-other/a.md', p)).toBeNull();
        // POSITIVE CONTROL for the prefix case: a NAME that merely starts with dots is inside.
        expect(insideRoot('/home/u/ws', '..notes.md', p)).toBe('/home/u/ws/..notes.md');
        // POSIX is case-SENSITIVE: a differently-cased root is another directory.
        expect(insideRoot('/home/u/ws', '/home/u/WS/a.md', p)).toBeNull();
    });

    it('POSIX: the root itself is not a file to send or a place to write', () => {
        expect(insideRoot('/home/u/ws', '.', path.posix)).toBeNull();
        expect(insideRoot('/home/u/ws', '/home/u/ws', path.posix)).toBeNull();
    });

    it('Windows: another drive, a UNC path and `..` are refused; the comparison ignores case', () => {
        const w = path.win32;
        expect(insideRoot('C:\\Users\\u\\ws', 'notes\\a.md', w)).toBe('C:\\Users\\u\\ws\\notes\\a.md');
        expect(insideRoot('C:\\Users\\u\\ws', 'notes/a.md', w)).toBe('C:\\Users\\u\\ws\\notes\\a.md');
        expect(insideRoot('C:\\Users\\u\\ws', 'c:\\users\\U\\WS\\a.md', w)).toBe('c:\\users\\U\\WS\\a.md');
        expect(insideRoot('C:\\Users\\u\\ws', 'D:\\Users\\u\\ws\\a.md', w)).toBeNull();
        expect(insideRoot('C:\\Users\\u\\ws', 'D:a.md', w)).toBeNull();
        expect(insideRoot('C:\\Users\\u\\ws', '\\\\server\\share\\a.md', w)).toBeNull();
        expect(insideRoot('C:\\Users\\u\\ws', '//server/share/a.md', w)).toBeNull();
        expect(insideRoot('C:\\Users\\u\\ws', '..\\..\\u2\\secret', w)).toBeNull();
        expect(insideRoot('C:\\Users\\u\\ws', 'C:\\Users\\u\\.ssh\\id_rsa', w)).toBeNull();
        expect(insideRoot('C:\\Users\\u\\ws', 'C:\\Users\\u\\ws-other\\a.md', w)).toBeNull();
    });

    it('a root that is not absolute confines nothing (fail closed)', () => {
        expect(insideRoot('', 'a.md', path.posix)).toBeNull();
        expect(insideRoot('ws', 'a.md', path.posix)).toBeNull();
        expect(insideRoot('ws', 'a.md', path.win32)).toBeNull();
    });
});

let base: string;
let ws: string;
let outside: string;
let store: InboxStore;
const a = mintAgentId();
const b = mintAgentId();

beforeEach(async () => {
    base = await mkdtemp(resolve(tmpdir(), 'genie2-inbox-confine-'));
    ws = resolve(base, 'ws');
    outside = resolve(base, 'elsewhere');
    await mkdir(resolve(ws, 'docs'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(resolve(ws, 'docs', 'notes.md'), 'inside');
    await writeFile(resolve(outside, 'secret.txt'), 'outside secret');
    store = await InboxStore.open(resolve(base, 'userData'));
});

afterEach(async () => {
    await rm(base, { recursive: true, force: true });
});

const blobs = async () => readdir(store.attachmentsDir).catch(() => [] as string[]);

describe('send — an agent attaches only files inside its own workspace', () => {
    it('POSITIVE CONTROL: absolute and workspace-relative paths inside the workspace are sent', async () => {
        const sent = await store.send({ from: a, to: b, text: 'x', attachments: [resolve(ws, 'docs', 'notes.md')], workspaceRoot: ws });
        expect(sent.attachments[0]).toMatchObject({ name: 'notes.md', size: 6 });
        const rel = await store.send({ from: a, to: b, text: 'y', attachments: ['docs/notes.md'], workspaceRoot: ws });
        expect(rel.attachments[0]).toMatchObject({ name: 'notes.md', size: 6 });
    });

    it('a relative path resolves against the WORKSPACE, not Genie’s working directory', async () => {
        // `package.json` exists in the process's cwd (the repo); it must not be what a relative path finds.
        await expect(store.send({ from: a, to: b, text: 'x', attachments: ['package.json'], workspaceRoot: ws })).rejects.toThrow(/could not be read/);
    });

    it('refuses an absolute path outside the workspace, and nothing is delivered or stored', async () => {
        await expect(store.send({ from: a, to: b, text: 'x', attachments: [resolve(outside, 'secret.txt')], workspaceRoot: ws }))
            .rejects.toThrow(/outside .*workspace/);
        expect((await store.receive({ participant: b })).messages).toEqual([]);
        expect(await blobs()).toEqual([]);
    });

    it('refuses `..` traversal out of the workspace', async () => {
        await expect(store.send({ from: a, to: b, text: 'x', attachments: ['../elsewhere/secret.txt'], workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
        await expect(store.send({ from: a, to: b, text: 'x', attachments: [resolve(ws, 'docs', '..', '..', 'elsewhere', 'secret.txt')], workspaceRoot: ws }))
            .rejects.toThrow(/outside .*workspace/);
    });

    it('one outside path fails the WHOLE send, even beside a good one', async () => {
        await expect(store.send({ from: a, to: b, text: 'x', attachments: ['docs/notes.md', resolve(outside, 'secret.txt')], workspaceRoot: ws }))
            .rejects.toThrow(/outside .*workspace/);
        expect(await blobs()).toEqual([]);
    });

    it.runIf(process.platform === 'win32')('Windows: another drive and a UNC path are refused before anything is read', async () => {
        const otherDrive = (ws[0]!.toUpperCase() === 'C' ? 'D' : 'C') + ':\\secret.txt';
        await expect(store.send({ from: a, to: b, text: 'x', attachments: [otherDrive], workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
        await expect(store.send({ from: a, to: b, text: 'x', attachments: ['\\\\localhost\\c$\\Windows\\win.ini'], workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
    });

    it.runIf(process.platform === 'win32')('Windows: the same workspace in another case is still inside', async () => {
        const sent = await store.send({ from: a, to: b, text: 'x', attachments: [resolve(ws, 'docs', 'notes.md').toUpperCase()], workspaceRoot: ws });
        expect(sent.attachments).toHaveLength(1);
    });

    it('a directory link (symlink / junction) inside the workspace that points OUT is refused', async () => {
        await dirLink(outside, resolve(ws, 'escape'));
        await expect(store.send({ from: a, to: b, text: 'x', attachments: ['escape/secret.txt'], workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
        expect(await blobs()).toEqual([]);
    });

    it('POSITIVE CONTROL for links: a link that stays inside the workspace still sends', async () => {
        await dirLink(resolve(ws, 'docs'), resolve(ws, 'alias'));
        const sent = await store.send({ from: a, to: b, text: 'x', attachments: ['alias/notes.md'], workspaceRoot: ws });
        expect(sent.attachments[0]).toMatchObject({ name: 'notes.md', size: 6 });
    });

    it.runIf(canFileSymlink)('a FILE symlink inside the workspace that points out is refused', async () => {
        await symlink(resolve(outside, 'secret.txt'), resolve(ws, 'innocent.md'), 'file');
        await expect(store.send({ from: a, to: b, text: 'x', attachments: ['innocent.md'], workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
    });

    it('a workspace whose own path runs through a link still works (the root is compared after links too)', async () => {
        const linkedRoot = resolve(base, 'ws-link');
        await dirLink(ws, linkedRoot);
        const sent = await store.send({ from: a, to: b, text: 'x', attachments: ['docs/notes.md'], workspaceRoot: linkedRoot });
        expect(sent.attachments).toHaveLength(1);
    });

    it('the refusal says why, names only the path the agent gave, and never where a link points', async () => {
        await dirLink(outside, resolve(ws, 'escape'));
        const error = await store.send({ from: a, to: b, text: 'x', attachments: ['escape/secret.txt'], workspaceRoot: ws }).catch((e: Error) => e);
        expect((error as Error).message).toMatch(/escape\/secret\.txt is outside .*workspace/);
        expect((error as Error).message).not.toContain(outside);
        expect((error as Error).message.toLowerCase()).not.toContain('elsewhere');
    });

    it('the refusal is the same whether the outside file exists or not — no probing the disk through it', async () => {
        const refusal = (file: string) => store.send({ from: a, to: b, text: 'x', attachments: [resolve(outside, file)], workspaceRoot: ws })
            .then(() => 'sent', (e: Error) => e.message);
        const there = await refusal('secret.txt');
        const absent = await refusal('nope.txt');
        expect(there).toMatch(/outside .*workspace/);
        expect(there.replace('secret.txt', 'F')).toBe(absent.replace('nope.txt', 'F'));
    });

    it('the executable refusal still holds inside the workspace', async () => {
        await writeFile(resolve(ws, 'tool.exe'), 'MZ');
        await expect(store.send({ from: a, to: b, text: 'x', attachments: ['tool.exe'], workspaceRoot: ws })).rejects.toThrow(/executable/);
    });

    it('an AGENT’s attachments without a workspace root are refused — the store fails closed', async () => {
        await expect(store.send({ from: a, to: b, text: 'x', attachments: [resolve(ws, 'docs', 'notes.md')] })).rejects.toThrow(/workspace/);
        expect(await blobs()).toEqual([]);
    });

    it('the PERSON’s own picks are not confined (the host’s file picker, the phone upload)', async () => {
        const sent = await store.send({ from: HUMAN, to: b, text: 'x', attachments: [resolve(outside, 'secret.txt')] });
        expect(sent.attachments).toHaveLength(1);
    });
});

describe('saveAttachment — an agent writes a received file only inside its own workspace', () => {
    let attId: string;
    beforeEach(async () => {
        const sent = await store.send({ from: a, to: b, text: 'x', attachments: ['docs/notes.md'], workspaceRoot: ws });
        attId = sent.attachments[0]!.id;
    });

    it('POSITIVE CONTROL: inside the workspace, absolute or relative, into a folder that does not exist yet', async () => {
        const abs = await store.saveAttachment(b, attId, resolve(ws, 'in', 'a.md'), { workspaceRoot: ws });
        expect((await readFile(abs)).toString()).toBe('inside');
        const rel = await store.saveAttachment(b, attId, 'in/deeper/b.md', { workspaceRoot: ws });
        expect(rel).toBe(resolve(ws, 'in', 'deeper', 'b.md'));
        expect((await readFile(rel)).toString()).toBe('inside');
    });

    it('refuses an absolute target outside the workspace, and writes nothing', async () => {
        await expect(store.saveAttachment(b, attId, resolve(outside, 'dropped.md'), { workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
        await expect(stat(resolve(outside, 'dropped.md'))).rejects.toThrow();
    });

    it('refuses `..` traversal, and creates no folder on the way', async () => {
        await expect(store.saveAttachment(b, attId, '../elsewhere/new/dropped.md', { workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
        await expect(stat(resolve(outside, 'new'))).rejects.toThrow();
    });

    it('a relative target lands in the workspace, not Genie’s working directory', async () => {
        const saved = await store.saveAttachment(b, attId, 'landed.md', { workspaceRoot: ws });
        expect(saved).toBe(resolve(ws, 'landed.md'));
    });

    it('refuses a target through a directory link that points out of the workspace', async () => {
        await dirLink(outside, resolve(ws, 'escape'));
        await expect(store.saveAttachment(b, attId, 'escape/dropped.md', { workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
        await expect(stat(resolve(outside, 'dropped.md'))).rejects.toThrow();
        // …including a folder that does not exist yet under the link.
        await expect(store.saveAttachment(b, attId, 'escape/new/dropped.md', { workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
        await expect(stat(resolve(outside, 'new'))).rejects.toThrow();
    });

    it.runIf(canFileSymlink)('refuses to write THROUGH a file symlink that points out, even with overwrite', async () => {
        await symlink(resolve(outside, 'secret.txt'), resolve(ws, 'innocent.md'), 'file');
        await expect(store.saveAttachment(b, attId, 'innocent.md', { workspaceRoot: ws, overwrite: true })).rejects.toThrow(/outside .*workspace/);
        expect((await readFile(resolve(outside, 'secret.txt'))).toString()).toBe('outside secret');
    });

    it.runIf(canFileSymlink)('refuses a DANGLING file symlink whose target would be created outside', async () => {
        await symlink(resolve(outside, 'not-yet.txt'), resolve(ws, 'dangling.md'), 'file');
        await expect(store.saveAttachment(b, attId, 'dangling.md', { workspaceRoot: ws, overwrite: true })).rejects.toThrow(/outside .*workspace/);
        await expect(stat(resolve(outside, 'not-yet.txt'))).rejects.toThrow();
    });

    it.runIf(process.platform === 'win32')('Windows: another drive and a UNC target are refused', async () => {
        const otherDrive = (ws[0]!.toUpperCase() === 'C' ? 'D' : 'C') + ':\\dropped.md';
        await expect(store.saveAttachment(b, attId, otherDrive, { workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
        await expect(store.saveAttachment(b, attId, '\\\\localhost\\c$\\dropped.md', { workspaceRoot: ws })).rejects.toThrow(/outside .*workspace/);
    });

    it('the executable refusal still holds inside the workspace', async () => {
        await expect(store.saveAttachment(b, attId, 'run.cmd', { workspaceRoot: ws })).rejects.toThrow(/executable/);
    });

    it('the refusal names only the path given, never where a link points', async () => {
        await dirLink(outside, resolve(ws, 'escape'));
        const message = await store.saveAttachment(b, attId, 'escape/dropped.md', { workspaceRoot: ws }).catch((e: Error) => e.message);
        expect(message).toMatch(/escape\/dropped\.md is outside .*workspace/);
        expect(message).not.toContain(outside);
    });

    it('an AGENT’s save without a workspace root is refused — fail closed', async () => {
        await expect(store.saveAttachment(b, attId, resolve(ws, 'x.md'))).rejects.toThrow(/workspace/);
        await expect(stat(resolve(ws, 'x.md'))).rejects.toThrow();
    });
});

describe('through the agentinbox tool — the caller’s workspace is the root', () => {
    let tools: Registration[];
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
    const kai = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'kai' });
    const roster: AgentRecord[] = [atlas, kai];
    let terminals: Record<string, Caller>;

    async function call(args: Record<string, unknown>) {
        const reg = tools.find((t) => t.definition.name === 'agentinbox')!;
        const r = await reg.handler(args as never, { server: 'genie', tool: 'agentinbox', headers: {} });
        return { ...r, json: JSON.parse(r.text) as Record<string, unknown> };
    }

    beforeEach(async () => {
        const kaiWs = resolve(base, 'ws-kai');
        mkdirSync(kaiWs, { recursive: true });
        terminals = {
            't-atlas': { agentId: atlas.id, agentName: 'atlas', workspaceId: 'tynn', workspacePath: ws },
            't-kai': { agentId: kai.id, agentName: 'kai', workspaceId: 'tynn', workspacePath: kaiWs },
        };
        const deps: GenieToolsDeps = {
            inbox: store,
            attention: await AttentionStore.open(resolve(base, 'userData'), store),
            roster: () => roster,
            resolveCaller: (id) => terminals[id] ?? null,
            workspaceSetting: () => ({ scope: 'self' }),
            userActive: () => true,
            glow: () => true,
            thumbsUp: () => {},
        };
        tools = genieTools(deps);
    });

    it('send refuses a file outside the sender’s workspace, saying why', async () => {
        const r = await call({ terminalId: 't-atlas', action: 'send', to: 'claude:kai', text: 'x', attachments: [resolve(outside, 'secret.txt')] });
        expect(r.isError).toBe(true);
        expect(String(r.json.error)).toMatch(/outside your workspace/);
        expect(await blobs()).toEqual([]);
    });

    it('saveAttachment lands inside the RECIPIENT’s workspace and refuses the sender’s', async () => {
        const sent = await call({ terminalId: 't-atlas', action: 'send', to: 'claude:kai', text: 'x', attachments: ['docs/notes.md'] });
        expect(sent.isError).toBe(false);
        const attId = (sent.json.attachments as Array<{ id: string }>)[0]!.id;
        const into = await call({ terminalId: 't-kai', action: 'saveAttachment', attachmentId: attId, path: 'got/notes.md' });
        expect(into.isError).toBe(false);
        expect(into.json.path).toBe(resolve(base, 'ws-kai', 'got', 'notes.md'));
        const across = await call({ terminalId: 't-kai', action: 'saveAttachment', attachmentId: attId, path: resolve(ws, 'planted.md') });
        expect(across.isError).toBe(true);
        expect(String(across.json.error)).toMatch(/outside your workspace/);
        await expect(stat(resolve(ws, 'planted.md'))).rejects.toThrow();
    });
});
