import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileEvent } from '../src/core/files-panel.js';
import { FilesHost } from '../src/main/files-host.js';

/**
 * THE FILES HOST (§4.3) over a REAL directory. Lists the workspace (never .git or node_modules),
 * opens a file by its confined relative path — a path outside the root is refused in words, a file
 * over the cap is refused in words with its size, a permission error is reported, never a blank —
 * and derives attribution from the agents' own tool events. A write on disk that no agent reported
 * shows up as unreported (`?`); the host never names an author it was not told.
 */

let root: string;
let host: FilesHost;
const events = new Map<string, FileEvent[]>();
const agents = [{ id: 'agent_kora', name: 'kora' }, { id: 'agent_zane', name: 'zane' }];

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-files-'));
    await mkdir(join(root, 'src', 'main'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(root, 'src', 'main', 'ipc.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'README.md'), '# hi\n');
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(root, 'node_modules', 'x', 'index.js'), '');
    events.clear();
    host = new FilesHost({
        workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: root } : null),
        agentsOf: () => agents,
        eventsOf: (agentId) => events.get(agentId) ?? [],
    });
});

afterEach(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
});

const settle = (ms = 300) => new Promise<void>((r) => setTimeout(r, ms));

describe('FilesHost', () => {
    it('lists the tree without .git or node_modules; an unknown workspace is null, not an empty tree', async () => {
        const tree = await host.tree('tynn');
        expect(tree!.map((n) => n.id)).toEqual(['src', 'README.md']);
        expect(tree![0]!.children![0]!.children![0]).toMatchObject({ id: 'src/main/ipc.ts', ext: 'ts' });
        expect(await host.tree('nope')).toBeNull();
    });

    it('opens a file by confined path; outside the root, over the cap, or unreadable is refused IN WORDS', async () => {
        expect(await host.open('tynn', 'src/main/ipc.ts')).toEqual({ ok: true, path: 'src/main/ipc.ts', text: 'export const a = 1;\n' });
        expect(await host.open('tynn', '../outside.txt')).toEqual({ ok: false, path: '../outside.txt', error: 'that path is outside the workspace; Genie opens nothing there' });
        expect(await host.open('tynn', 'missing.ts')).toMatchObject({ ok: false, path: 'missing.ts' });
        expect((await host.open('tynn', 'missing.ts') as { error: string }).error).toMatch(/ENOENT|no such file/);
        host = new FilesHost({ workspace: () => ({ id: 'tynn', path: root }), agentsOf: () => [], eventsOf: () => [], sizeCap: 4 });
        // A 5-byte file over a 4-byte cap is "5 B", never "0 MB" — the words carry the real size.
        expect(await host.open('tynn', 'README.md')).toEqual({ ok: false, path: 'README.md', error: 'this file is 5 B; Genie will not open it' });
    });

    it('attribution comes from the agents of THAT workspace; a disk write nobody reported is unreported, never attributed', async () => {
        events.set('agent_kora', [{ agentId: 'agent_kora', agentName: 'kora', toolKind: 'edit', status: 'in_progress', rawInput: { file_path: join(root, 'src/main/ipc.ts') } }]);
        events.set('agent_zane', [{ agentId: 'agent_zane', agentName: 'zane', toolKind: 'read', status: 'in_progress', rawInput: { file_path: join(root, 'README.md') } }]);
        const before = await host.state('tynn');
        expect(before!.files).toEqual([{ path: 'src/main/ipc.ts', agents: [{ id: 'agent_kora', name: 'kora' }], count: 1, inFlight: true }]);
        expect(before!.activity).toEqual([{ agent: 'kora', verb: 'writing', path: 'src/main/ipc.ts' }, { agent: 'zane', verb: 'reading', path: 'README.md' }]);
        expect(before!.unreported).toEqual([]);

        const changes: string[] = [];
        host.onChange((workspaceId) => { changes.push(workspaceId); });
        await host.watch('tynn');
        await writeFile(join(root, 'src', 'main', 'ipc.ts'), 'export const a = 2;\n');
        await writeFile(join(root, 'mystery.ts'), 'who wrote this\n');
        await settle();
        const after = await host.state('tynn');
        // ipc.ts was reported by kora; mystery.ts by nobody.
        expect(after!.unreported).toEqual(['mystery.ts']);
        expect(changes).toContain('tynn');
        expect(after!.changed).toEqual([{ who: 'kora', files: ['src/main/ipc.ts'] }, { who: '?', files: ['mystery.ts'] }]);
    });

    it('nothing changed → changed is null (absent), activity empty, files empty', async () => {
        const s = await host.state('tynn');
        expect(s).toEqual({ files: [], activity: [], unreported: [], changed: null });
    });
});
