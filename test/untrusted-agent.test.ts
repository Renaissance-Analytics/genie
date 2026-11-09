import { claudeArgs } from '@particle-academy/prism-acp';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionDecisionFor } from '../src/core/agent-ops.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { ComposedServices } from '../src/main/compose.js';
import type { composeServices } from './helpers/compose-alone.js';
import { writeGenieInstructions } from '../src/main/genie-instructions.js';
import { SessionHost, claudeTrustOptions, codexRecordFor, type DriverFor, type GenieInstructionFiles } from '../src/main/session-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { composeTracker } from './support/compose-tracker.js';

/**
 * AN AGENT IN A WORKSPACE THE PERSON HAS NOT TRUSTED. Its folder's settings, hooks, servers, instructions and skills stay unread; Genie's own reach it by Genie's own route; a shell call asks; and Genie writes nothing into that folder.
 *
 * What the CLI does with these flags is not tested here: that was measured against a stand-in API (provider-repo-config.mjs, genie-instructions-route.mjs in the envelope) and by prism against real CLIs. A real signed-in run is still to come.
 */
const FILES: GenieInstructionFiles = { promptFile: join('/genie', 'prompt.md'), pluginDir: join('/genie', 'plugin'), promptText: 'genie words' };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'untrusted-agent-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

describe('the launch', () => {
    it('trusted: nothing changes', () => {
        expect(claudeTrustOptions(null)).toEqual({});
    });

    it("untrusted: the person's own settings only, Genie's own servers only, and Genie's words by file", () => {
        expect(claudeTrustOptions(FILES)).toEqual({
            settingSources: ['user'],
            strictMcpConfig: true,
            appendSystemPromptFile: FILES.promptFile,
            pluginDirs: [FILES.pluginDir],
        });
    });

    it('what the provider library really puts on the command line for them, and the paths it requires', () => {
        const absolute = { promptFile: resolve('/genie/prompt.md'), pluginDir: resolve('/genie/plugin'), promptText: 'x' };
        const args = claudeArgs({ cwd: absolute.pluginDir, ...claudeTrustOptions(absolute) });
        expect(args.slice(args.indexOf('--append-system-prompt-file'), args.indexOf('--append-system-prompt-file') + 2)).toEqual(['--append-system-prompt-file', absolute.promptFile]);
        expect(args.slice(args.indexOf('--plugin-dir'), args.indexOf('--plugin-dir') + 2)).toEqual(['--plugin-dir', absolute.pluginDir]);
        expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--setting-sources', 'user']));
        expect(() => claudeArgs({ cwd: absolute.pluginDir, ...claudeTrustOptions({ promptFile: 'relative/prompt.md', pluginDir: absolute.pluginDir, promptText: 'x' }) })).toThrow(/appendSystemPromptFile/);
    });

    it('no flags of its own through binaryArgs: a provider configured as a script keeps exactly its own', () => {
        expect(claudeTrustOptions(FILES)).not.toHaveProperty('binaryArgs');
    });

    it('Codex: an agent set to run unasked does not, while untrusted', () => {
        const record = { ...agentRecord({ id: mintAgentId(), workspaceId: 'w', provider: 'codex', name: 'a' }), autoApprove: true };
        expect(codexRecordFor(record, FILES).autoApprove).toBe(false);
        expect(codexRecordFor(record, null).autoApprove).toBe(true);
    });
});

describe('a shell call', () => {
    it.each([[undefined, 'ask'], ['all', 'ask'], ['ask', 'ask'], ['edits', 'deny']] as const)('untrusted, set to %s: %s', (setting, answer) => {
        expect(permissionDecisionFor(setting, { untrusted: true })).toBe(answer);
    });
    it.each([[undefined, 'allow'], ['all', 'allow'], ['ask', 'ask'], ['edits', 'deny']] as const)('trusted, set to %s: %s', (setting, answer) => {
        expect(permissionDecisionFor(setting)).toBe(answer);
    });
});

describe('every launch carries it', () => {
    function fixture(untrustedFilesFor: () => Promise<GenieInstructionFiles | null>) {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' });
        const created: Array<{ resume: string | null; untrusted: GenieInstructionFiles | undefined }> = [];
        let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
        const tree: ProcessTree = { snapshot: () => [...processes], killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return Promise.resolve([]) as never; } } as ProcessTree;
        const driverFor: DriverFor = (agent, _cwd, resume, extras) => {
            created.push({ resume, untrusted: extras?.untrusted });
            return () => {
                const pid = process.pid + 1_000_000 + created.length;
                return { start: () => { processes.push({ pid, ppid: process.pid, started: 3, name: `${agent.provider}-fixture` }); }, prompt: () => {}, kill: () => { processes = processes.filter((p) => p.pid !== pid); }, cliSessionId: null, ready: Promise.resolve() } as never;
            };
        };
        const host = new SessionHost({ userData: dir, driverFor, processTree: tree, stopGraceMs: 0, mcpServersFor: () => [], untrustedFilesFor, lifecycle: { spawned: () => {}, ended: () => {}, straggler: () => {} } });
        return { host, record, created };
    }

    it('a first launch, a resumed one and a relaunch after that: each construction, each with the flags', async () => {
        const t = fixture(async () => FILES);
        expect(t.host.start(t.record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(t.created).toHaveLength(1));
        t.host.stop(t.record.id, { graceful: false });
        await t.host.ended(t.record.id);
        const resumed = { ...t.record, threadId: 'thread-1' };
        expect(t.host.start(resumed as never, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(t.created).toHaveLength(2));
        t.host.stop(t.record.id, { graceful: false });
        await t.host.ended(t.record.id);
        expect(t.host.start(resumed as never, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(t.created).toHaveLength(3));
        expect(t.created.map((c) => [c.resume, c.untrusted])).toEqual([[null, FILES], ['thread-1', FILES], ['thread-1', FILES]]);
        t.host.stopAll();
        await t.host.settled();
    });

    it('trusted: none', async () => {
        const t = fixture(async () => null);
        t.host.start(t.record, dir);
        await vi.waitFor(() => expect(t.created).toHaveLength(1));
        expect(t.created[0]?.untrusted).toBeUndefined();
        t.host.stopAll();
        await t.host.settled();
    });

    it('when the answer cannot be had, no provider is created: it does not start as if trusted', async () => {
        const t = fixture(async () => { throw new Error('could not read the workspace'); });
        t.host.start(t.record, dir);
        await new Promise((r) => setTimeout(r, 100));
        expect(t.created).toEqual([]);
        t.host.stopAll();
        await t.host.settled();
    });
});

describe("Genie's own words, on this machine", () => {
    it('are written outside any workspace: the protocol, the note that this folder is not trusted yet, and each skill as a plugin', async () => {
        const home = join(dir, 'genie');
        const files = await writeGenieInstructions(home, [{ name: 'imDone', description: 'x' }]);
        expect(files.promptFile.startsWith(home)).toBe(true);
        expect(files.pluginDir.startsWith(home)).toBe(true);
        const prompt = readFileSync(files.promptFile, 'utf8');
        expect(prompt).toContain('`imDone`');
        expect(prompt).toMatch(/not trusted/i);
        expect(JSON.parse(readFileSync(join(files.pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('genie-own');
        expect(readFileSync(join(files.pluginDir, 'skills', 'genie', 'SKILL.md'), 'utf8')).toContain('name: genie');
    });

    it('writing them again replaces them, whatever was there', async () => {
        const home = join(dir, 'genie');
        const first = await writeGenieInstructions(home, [{ name: 'one', description: 'x' }]);
        const second = await writeGenieInstructions(home, [{ name: 'two', description: 'x' }]);
        expect([second.promptFile, second.pluginDir]).toEqual([first.promptFile, first.pluginDir]);
        expect(second.promptText).toContain('`two`');
        expect(readFileSync(second.promptFile, 'utf8')).toContain('`two`');
        expect(readFileSync(second.promptFile, 'utf8')).not.toContain('`one`');
    });
});

describe('through the real composition', () => {
    const pty: PtyPort = { open: () => ({ id: 't', pid: 1, shell: 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
    const composed = composeTracker();
    let services: ComposedServices;
    let workspaces: Array<{ id: string; path: string }> = [];
    let folder: string;
    const launch = async () => {
        services = await composed.compose({
            userData: join(dir, 'home'), pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, workspaces: () => workspaces,
            mcpEndpoint: () => ({ url: 'http://127.0.0.1:43127/mcp', token: 'abc' }), mcpTools: () => [{ name: 'imDone', description: 'x' }],
        } as Parameters<typeof composeServices>[0]);
    };
    beforeEach(async () => {
        folder = join(dir, 'acme');
        mkdirSync(join(folder, '.claude'), { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: folder, windowsHide: true });
        writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'theirs' }] }] } }));
        workspaces = [];
        await launch();
        await services.shutdown();
        workspaces = [{ id: 'acme', path: folder }];
        await launch();
    });
    afterEach(async () => { await composed.shutdownAll(); });
    const record = () => agentRecord({ id: mintAgentId(), workspaceId: 'acme', provider: 'claude', name: 'atlas' });

    it("untrusted: an agent gets Genie's files; and Genie writes nothing into the folder, its token above all", async () => {
        const files = await services.untrustedFilesFor(record());
        expect(files).not.toBeNull();
        expect(existsSync(files!.promptFile)).toBe(true);
        expect(files!.promptFile.startsWith(folder)).toBe(false);
        await services.syncConfig(folder);
        await services.syncAgentDocs(folder);
        expect(existsSync(join(folder, '.mcp.json'))).toBe(false);
        expect(existsSync(join(folder, '.claude', 'settings.local.json'))).toBe(false);
        expect(existsSync(join(folder, 'CLAUDE.md'))).toBe(false);
    });

    it('CONTROL: trusted, the same calls write them, and the agent starts as ever', async () => {
        await services.workspaceTrust.trust('acme');
        expect(await services.untrustedFilesFor(record())).toBeNull();
        await services.syncConfig(folder);
        await services.syncAgentDocs(folder);
        expect(existsSync(join(folder, '.mcp.json'))).toBe(true);
        expect(existsSync(join(folder, 'CLAUDE.md'))).toBe(true);
    });

    it("the built-in Genie agent isn't in any workspace, and is not held to one", async () => {
        const osa = agentRecord({ id: mintAgentId(), workspaceId: '__genie__', provider: 'claude', name: 'genie' });
        expect(await services.untrustedFilesFor(osa)).toBeNull();
    });
});
