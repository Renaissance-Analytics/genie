import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT, edge, kindCase, node, nodeCommand, runNow, save, useGenie, WS, type Genie } from './harness.js';

/**
 * GENIE'S OWN STEPS: Prompt an agent, Run a command, Add knowledge, Move a file — each run by Genie's runner through the
 * ports main composes (compose.ts): the agent prompter on the live sessions, the SUPERVISOR running the command as a
 * real process, the knowledge store, the file mover. The effect is read where it lands: the agent's session, the
 * supervisor's kept log and the run's exit code, the knowledge graph, the folder.
 */

const genie = useGenie();
const manual = node('t', '@particle-academy/manual_trigger');
const log = (id: string, message: string, x = 600) => node(id, '@particle-academy/log', { level: 'info', message }, x);
const command = (id: string, cmd: string, extra: Record<string, unknown> = {}) => node(id, 'genie/terminal_run', { workspace: WS, command: cmd, ...extra }, 300);

describe('Prompt an agent', () => {
    kindCase('genie/agent_prompt', 'reaches the agent’s live session, from the flow by name, waits for its turn, and hands on the reply', genie, async () => {
        const g = genie();
        const id = await save(g, 'standup', [manual, node('p', 'genie/agent_prompt', { agent: AGENT, prompt: 'post the standup' }, 300), log('l', 'reply: {{ $json.reply }}')], [edge('t', 'p'), edge('p', 'l')]);
        const run = await runNow(g, id);
        expect(run).toMatchObject({ outcome: 'ran', nodes: { p: 'ran', l: 'ran' }, log: ['reply: atlas did: post the standup'] });
        expect(g.sessions.prompts).toEqual([{ agentId: 'agent_atlas', text: 'post the standup', by: 'flow "standup"' }]);
    });

    it('an agent mid-turn is HELD, never prompted inside another turn', async () => {
        const g = genie();
        const id = await save(g, 'standup', [manual, node('p', 'genie/agent_prompt', { agent: AGENT, prompt: 'post it' }, 300), log('l', 'after')], [edge('t', 'p'), edge('p', 'l')]);
        g.sessions.mode = 'busy';
        expect(await runNow(g, id)).toMatchObject({ outcome: 'held', reason: 'atlas is busy (mid-turn); the prompt was not delivered, so it never lands inside another turn', nodes: { p: 'held', l: 'not reached' } });
        expect(g.sessions.prompts).toEqual([]);
    });
});

describe('Run a command', () => {
    const supervisorLog = (g: Genie, flowId: string) => g.services.supervisor.log(`flow-run:${flowId}`) ?? '';

    kindCase('genie/terminal_run', 'runs as a supervised process in the workspace; its output is KEPT and handed on with exit code 0', genie, async () => {
        const g = genie();
        const id = await save(g, 'report', [manual, command('c', nodeCommand("process.stdout.write('hello from flows')")), log('l', 'exit={{ $json.exitCode }} ok={{ $json.ok }} out={{ $json.output }}')], [edge('t', 'c'), edge('c', 'l')]);
        const run = await runNow(g, id);
        expect(run).toMatchObject({ outcome: 'ran', nodes: { c: 'ran', l: 'ran' } });
        expect(run.log).toEqual([expect.stringMatching(/^exit=0 ok=true out=[\s\S]*hello from flows/)]);
        expect(g.pty.opened.at(-1)).toMatchObject({ cwd: g.ws });
        expect(supervisorLog(g, id)).toContain('hello from flows');
        expect(g.services.supervisor.status(`flow-run:${id}`)).toMatchObject({ state: 'exited', exitCode: 0, workspaceId: WS });
    });

    it('in a folder of the workspace (`cwd`)', async () => {
        const g = genie();
        await mkdir(join(g.ws, 'tools'), { recursive: true });
        const id = await save(g, 'where', [manual, command('c', nodeCommand('process.stdout.write(process.cwd())'), { cwd: 'tools' }), log('l', '{{ $json.output }}')], [edge('t', 'c'), edge('c', 'l')]);
        await runNow(g, id);
        expect(g.pty.opened.at(-1)).toMatchObject({ cwd: join(g.ws, 'tools') });
        expect(supervisorLog(g, id)).toContain(join(g.ws, 'tools'));
    });

    it('a non-zero exit FAILS the run at that step, with the code; what came after is not reached; the output is still kept', async () => {
        const g = genie();
        const id = await save(g, 'broken', [manual, command('c', nodeCommand("process.stdout.write('tests: 2 failed');process.exit(3)")), log('l', 'never')], [edge('t', 'c'), edge('c', 'l')]);
        const run = await runNow(g, id);
        expect(run).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('ended with exit code 3'), nodes: { t: 'ran', c: 'failed', l: 'not reached' } });
        expect(run.log ?? []).toEqual([]);
        expect(supervisorLog(g, id)).toContain('tests: 2 failed');
    });

    it('"Continue on a non-zero exit": the run goes on, and the next step can branch on the exit code', async () => {
        const g = genie();
        const id = await save(g, 'tolerant', [
            manual,
            command('c', nodeCommand('process.exit(3)'), { allowFailure: true }),
            node('b', '@particle-academy/branch', { match: 'all', conditions: [{ left: '{{ $json.exitCode }}', operator: 'eq', right: '3' }] }, 450),
            log('three', 'saw exit {{ $json.exitCode }}'),
            log('other', 'something else'),
        ], [edge('t', 'c'), edge('c', 'b'), edge('b', 'three', 'true'), edge('b', 'other', 'false')]);
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', log: ['saw exit 3'], nodes: { c: 'ran', three: 'ran', other: 'skipped' } });
    });
});

describe('Add knowledge', () => {
    kindCase('genie/knowledge_add', 'writes a memory into the flow’s workspace — title and body templated, its class and tags kept', genie, async () => {
        const g = genie();
        const id = await save(g, 'remember', [
            manual,
            node('x', '@particle-academy/transform', { mode: 'fields', fields: [{ key: 'result', value: 'all green' }] }, 200),
            node('k', 'genie/knowledge_add', { workspace: WS, title: 'Nightly report', body: 'the build was {{ in.result }}', class: 'episodic', tags: 'nightly, ci' }, 400),
        ], [edge('t', 'x'), edge('x', 'k')]);
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', nodes: { k: 'ran' } });
        const memory = g.services.knowledge.list({ scopes: [{ kind: 'workspace', id: WS }], limit: 50 }).nodes.find((k) => k.title === 'Nightly report');
        expect(memory).toMatchObject({ body: 'the build was all green', class: 'episodic', tags: ['nightly', 'ci'], scope: { kind: 'workspace', id: WS } });
    });
});

describe('Move a file', () => {
    kindCase('genie/file_move', 'moves a file named relative to the workspace into a folder it creates, never overwriting', genie, async () => {
        const g = genie();
        await mkdir(join(g.ws, 'uploads'), { recursive: true });
        await mkdir(join(g.ws, 'archive'), { recursive: true });
        await writeFile(join(g.ws, 'uploads', 'report.pdf'), 'new');
        await writeFile(join(g.ws, 'archive', 'report.pdf'), 'already here');
        const id = await save(g, 'archive it', [manual, node('m', 'genie/file_move', { workspace: WS, from: 'uploads/report.pdf', to: 'archive' }, 300), log('l', 'moved={{ $json.moved }}')], [edge('t', 'm'), edge('m', 'l')]);
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', nodes: { m: 'ran' }, log: ['moved=true'] });
        expect(existsSync(join(g.ws, 'uploads', 'report.pdf'))).toBe(false);
        expect((await readdir(join(g.ws, 'archive'))).sort()).toEqual(['report (2).pdf', 'report.pdf']);
    });

    it('refuses a file outside the workspace, moving nothing, and the run fails in those words', async () => {
        const g = genie();
        await writeFile(join(g.dir, 'outside.txt'), 'x');
        const id = await save(g, 'escape', [manual, node('m', 'genie/file_move', { workspace: WS, from: '../outside.txt', to: 'archive' }, 300)], [edge('t', 'm')]);
        expect(await runNow(g, id)).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/outside the workspace/), nodes: { m: 'failed' } });
        expect(existsSync(join(g.dir, 'outside.txt'))).toBe(true);
    });
});
