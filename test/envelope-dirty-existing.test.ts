import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentFilesHealth } from '../src/core/agent-files-health.js';
import { ensureEnvelopeDirty, nodeDirtyFs } from '../src/main/envelope-dirty.js';
import { featureWorkspaceFiles } from '../src/main/feature-workspace-files.js';
import { hostingRig, type HostingRig } from './helpers/hosting-rig.js';

/**
 * AN EXISTING ENVELOPE GETS .ai/_dirty/ TOO (the owner, 2026-11-17, after #2033 / Tynn #818 gave it to new ones). When
 * Genie opens an .agi envelope that has no `.ai/_dirty/`, it makes the folder with a `.gitkeep` and adds the two
 * `.gitignore` lines `.ai/_dirty/**` and `!.ai/_dirty/.gitkeep` that are missing, never one twice. Only in a workspace
 * that is trusted and not hibernated; never through a link (`.ai`, `.ai/_dirty`, or the `.gitignore` itself); a second
 * run does nothing; nothing outside `.ai/_dirty/` and that one `.gitignore` edit is touched; nothing is committed.
 *
 * The trust and hibernation cases go through the real hosting trust (hostingRig's stack.trust, the `mayWriteInto`
 * genie-host hands featureWorkspaceFiles), each refusal beside a trusted control that does write.
 */
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function envelope(files: Record<string, string> = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'dirty-existing-'));
    made.push(root);
    mkdirSync(join(root, '.ai', 'plans'), { recursive: true });
    mkdirSync(join(root, 'repos'));
    writeFileSync(join(root, 'project.json'), '{ "name": "Acme" }\n');
    writeFileSync(join(root, '.ai', 'plans', 'p.md'), 'plan\n');
    for (const [p, text] of Object.entries(files)) writeFileSync(join(root, p), text);
    return root;
}

/** Every entry under root (links not followed), with a file's bytes, a dir as `<dir>` and a link as `<link>`. */
function tree(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            if (name === '.git') continue;
            const p = join(dir, name);
            const s = lstatSync(p);
            const key = relative(root, p).split('\\').join('/');
            if (s.isSymbolicLink()) out[key] = '<link>';
            else if (s.isDirectory()) { out[key] = '<dir>'; walk(p); }
            else out[key] = readFileSync(p, 'utf8');
        }
    };
    walk(root);
    return out;
}

const run = (root: string) => ensureEnvelopeDirty({ workspacePath: root, fs: nodeDirtyFs() });
const gitignore = (root: string) => readFileSync(join(root, '.gitignore'), 'utf8');

describe('ensureEnvelopeDirty: an existing envelope with no .ai/_dirty/', () => {
    it('CONTROL: an envelope that already has .ai/_dirty/ and both lines is left exactly as it was', async () => {
        const root = envelope({ '.gitignore': 'node_modules/\n.ai/_dirty/**\n!.ai/_dirty/.gitkeep\n' });
        mkdirSync(join(root, '.ai', '_dirty'));
        writeFileSync(join(root, '.ai', '_dirty', 'dropped.png'), 'png');
        const before = tree(root);
        await run(root);
        expect(tree(root)).toEqual(before);
    });

    it('gets the folder, with an empty .gitkeep', async () => {
        const root = envelope({ '.gitignore': 'node_modules/\n' });
        await run(root);
        expect(statSync(join(root, '.ai', '_dirty')).isDirectory()).toBe(true);
        expect(readFileSync(join(root, '.ai', '_dirty', '.gitkeep'), 'utf8')).toBe('');
    });

    it('its .gitignore gains both lines after what was there, in the file\'s own line endings', async () => {
        const root = envelope({ '.gitignore': 'node_modules/\r\nsandbox/**' });
        await run(root);
        const text = gitignore(root);
        expect(text.startsWith('node_modules/\r\nsandbox/**\r\n')).toBe(true);
        const lines = text.split('\r\n');
        expect(lines).toEqual(expect.arrayContaining(['.ai/_dirty/**', '!.ai/_dirty/.gitkeep']));
        expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    });

    it('a line already there is not added again; only the missing one is', async () => {
        const root = envelope({ '.gitignore': '.ai/_dirty/**\n' });
        await run(root);
        const lines = gitignore(root).split('\n').map((l) => l.trim());
        expect(lines.filter((l) => l === '.ai/_dirty/**')).toHaveLength(1);
        expect(lines.filter((l) => l === '!.ai/_dirty/.gitkeep')).toHaveLength(1);
    });

    it('with no .gitignore at all, one is made holding the two lines', async () => {
        const root = envelope();
        await run(root);
        const lines = gitignore(root).split('\n').map((l) => l.trim());
        expect(lines).toEqual(expect.arrayContaining(['.ai/_dirty/**', '!.ai/_dirty/.gitkeep']));
    });

    it('running it twice: the second run changes nothing', async () => {
        const root = envelope({ '.gitignore': 'node_modules/\n' });
        await run(root);
        expect(existsSync(join(root, '.ai', '_dirty', '.gitkeep'))).toBe(true);
        const once = tree(root);
        await run(root);
        expect(tree(root)).toEqual(once);
    });

    it('touches nothing but .ai/_dirty/ and the .gitignore, and commits nothing (HEAD stays, a dropped file is ignored)', async () => {
        const root = envelope({ '.gitignore': 'node_modules/\n', 'README.md': '# Acme\n' });
        const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
        git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'first');
        const head = git('rev-parse', 'HEAD').trim();
        const before = tree(root);
        await run(root);
        const after = tree(root);
        const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]).sort();
        expect(changed).toEqual(['.ai/_dirty', '.ai/_dirty/.gitkeep', '.gitignore']);
        expect(git('rev-parse', 'HEAD').trim()).toBe(head);
        writeFileSync(join(root, '.ai', '_dirty', 'dropped.png'), 'png');
        expect(git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort()).toEqual([' M .gitignore', '?? .ai/_dirty/.gitkeep']);
    });

    it('CONTROL: .ai is a link: nothing is written, through it or beside it', async () => {
        const root = envelope({ '.gitignore': 'node_modules/\n' });
        const elsewhere = mkdtempSync(join(tmpdir(), 'dirty-elsewhere-'));
        made.push(elsewhere);
        rmSync(join(root, '.ai'), { recursive: true });
        symlinkSync(elsewhere, join(root, '.ai'), 'dir');
        const before = tree(root);
        await run(root);
        expect(tree(root)).toEqual(before);
        expect(readdirSync(elsewhere)).toEqual([]);
    });

    it('CONTROL: .ai/_dirty is a link: nothing is written, through it or beside it', async () => {
        const root = envelope({ '.gitignore': 'node_modules/\n' });
        const elsewhere = mkdtempSync(join(tmpdir(), 'dirty-elsewhere-'));
        made.push(elsewhere);
        symlinkSync(elsewhere, join(root, '.ai', '_dirty'), 'dir');
        const before = tree(root);
        await run(root);
        expect(tree(root)).toEqual(before);
        expect(readdirSync(elsewhere)).toEqual([]);
    });

    it('CONTROL: the .gitignore is a link: nothing is written, through it or beside it', async () => {
        const root = envelope();
        const elsewhere = mkdtempSync(join(tmpdir(), 'dirty-elsewhere-'));
        made.push(elsewhere);
        writeFileSync(join(elsewhere, 'shared.gitignore'), 'node_modules/\n');
        symlinkSync(join(elsewhere, 'shared.gitignore'), join(root, '.gitignore'), 'file');
        const before = tree(root);
        await run(root);
        expect(tree(root)).toEqual(before);
        expect(readFileSync(join(elsewhere, 'shared.gitignore'), 'utf8')).toBe('node_modules/\n');
    });

    it('CONTROL: a folder that is not an envelope (no project.json) is left alone', async () => {
        const root = envelope({ '.gitignore': 'node_modules/\n' });
        rmSync(join(root, 'project.json'));
        const before = tree(root);
        await run(root);
        expect(tree(root)).toEqual(before);
    });
});

describe('only in a workspace that is trusted and not hibernated (the real hosting trust)', () => {
    let r: HostingRig | null = null;
    afterEach(async () => { await r?.close(); r = null; });

    async function rig() {
        const ws = { id: 'ws', path: '', asleep: false };
        // A trust record that carries nothing: the workspace is untrusted until the person says yes (trust-host-owns.test.ts).
        const home = mkdtempSync(join(tmpdir(), 'dirty-existing-home-'));
        mkdirSync(join(home, 'runtime'), { recursive: true });
        writeFileSync(join(home, 'runtime', 'workspace-trust.json'), JSON.stringify({ version: 1, carried: [], pendingCarry: [], sites: {}, workspaces: {} }));
        r = await hostingRig({ home, workspaces: (path) => { ws.path = path; return [ws]; } });
        // Something to trust (a folder that lists nothing to run is trusted as it is): an MCP server the workspace names.
        writeFileSync(join(r.ws, '.mcp.json'), JSON.stringify({ mcpServers: { theirs: { command: 'node', args: ['theirs.js'] } } }));
        expect(await r.stack.trust.refresh('ws')).toMatchObject({ trusted: false });
        mkdirSync(join(r.ws, '.ai'));
        writeFileSync(join(r.ws, '.gitignore'), 'node_modules/\n');
        const trust = r.stack.trust;
        const files = featureWorkspaceFiles({ mayWriteInto: (folder) => trust.mayWriteInto(folder), settings: { snapshot: () => ({ mcp_sync_agents: false }) },
            health: new AgentFilesHealth(), tools: () => [], tracking: () => 'files' });
        return { ws, trust, root: r.ws, sync: () => files.syncAgentDocs(r!.ws) };
    }

    it('trusted and awake: opening it gives the envelope .ai/_dirty/ and its lines', async () => {
        const f = await rig();
        expect(await f.trust.trust('ws')).toMatchObject({ trusted: true });
        await f.sync();
        expect(existsSync(join(f.root, '.ai', '_dirty', '.gitkeep'))).toBe(true);
        expect(gitignore(f.root).split('\n')).toEqual(expect.arrayContaining(['.ai/_dirty/**', '!.ai/_dirty/.gitkeep']));
    });

    it('CONTROL: not trusted: no .ai/_dirty/, no line', async () => {
        const f = await rig();
        expect(await f.trust.mayWriteInto(f.root)).toBe(false);
        await f.sync();
        expect(existsSync(join(f.root, '.ai', '_dirty'))).toBe(false);
        expect(gitignore(f.root)).toBe('node_modules/\n');
    });

    it('CONTROL: trusted but hibernated: no .ai/_dirty/, no line', async () => {
        const f = await rig();
        expect(await f.trust.trust('ws')).toMatchObject({ trusted: true });
        f.ws.asleep = true;
        expect(await f.trust.mayWriteInto(f.root)).toBe(false);
        await f.sync();
        expect(existsSync(join(f.root, '.ai', '_dirty'))).toBe(false);
        expect(gitignore(f.root)).toBe('node_modules/\n');
    });
});
