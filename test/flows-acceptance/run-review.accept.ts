import { describe, expect, it } from 'vitest';
import { AGENT, edge, node, nodeCommand, runNow, save, useGenie, WS } from './harness.js';

/**
 * THE RUN REVIEW'S RECORD (Tynn #839), through Genie's real composition: the supervisor runs the command as a real
 * process, the agent prompter reaches the live session, fancy-flow's branch chooses its way. What the Flow window's run
 * review reads must be what the run store recorded on that path, not what a unit test's fake would say.
 */

const genie = useGenie();
const manual = node('t', '@particle-academy/manual_trigger');
const step = (run: { timeline?: readonly { nodeId: string }[] }, id: string) => run.timeline?.find((s) => s.nodeId === id) as Record<string, any> | undefined;

describe('a run records each step for its review', () => {
    it('command → branch on its exit code → prompt: exit code, output and process; the way taken and why; the prompt, delivery and reply; times; who', async () => {
        const g = genie();
        const cmd = nodeCommand("process.stdout.write('found 3');process.exit(3)");
        const id = await save(g, 'review', [
            manual,
            node('c', 'genie/terminal_run', { workspace: WS, command: cmd, allowFailure: true }, 200),
            node('b', '@particle-academy/branch', { match: 'all', conditions: [{ left: '{{ $json.exitCode }}', operator: 'eq', right: '3' }] }, 400),
            node('p', 'genie/agent_prompt', { agent: AGENT, prompt: 'look at {{ in.output }}', waitForReply: true }, 600),
            node('n', '@particle-academy/log', { level: 'info', message: 'nothing' }, 600),
        ], [edge('t', 'c'), edge('c', 'b'), edge('b', 'p', 'true'), edge('b', 'n', 'false')]);
        // The pid the supervisor gave the command, read while it runs (the supervisor clears it once the process exits).
        let pid: number | null = null;
        const off = g.services.supervisor.onChange((s) => { if (s.id === `flow-run:${id}` && s.pid !== null) pid = s.pid; });
        const run = await runNow(g, id);
        off();
        expect(pid).not.toBeNull();
        // A supervised command's output for its run is the process's kept log for that run: the supervisor's own lines
        // frame the program's (process-supervisor.ts: `started (pid N): <command>`, `exited with code N`). That is what
        // Genie already hands on as {{ in.output }}, so it is what the prompt carries — measured on the real composition.
        const output = `[genie] started (pid ${pid}): ${cmd}\nfound 3\n[genie] exited with code 3`;
        expect(run).toMatchObject({ outcome: 'ran', nodes: { c: 'ran', b: 'ran', p: 'ran', n: 'skipped' }, startedBy: { kind: 'user' } });
        expect(step(run, 'c')).toMatchObject({ command: { command: cmd, exitCode: 3, output, processId: `flow-run:${id}` } });
        expect(step(run, 'b')!.route).toEqual({ port: 'true', condition: 'all: {{ $json.exitCode }} eq 3' });
        // The prompt recorded is EXACTLY the text the agent's live session received, and the reply is the agent's answer.
        expect(g.sessions.prompts.map((x) => x.text)).toEqual([`look at ${output}`]);
        expect(step(run, 'p')!.prompt).toMatchObject({ agent: AGENT, text: `look at ${output}`, reply: `atlas did: look at ${output}` });
        expect(typeof step(run, 'p')!.prompt.deliveredAt).toBe('string');
        for (const s of ['c', 'b', 'p']) expect(Date.parse(step(run, s)!.endedAt)).toBeGreaterThanOrEqual(Date.parse(step(run, s)!.startedAt));
        expect(step(run, 'n')?.startedAt).toBeUndefined();
    });

    it('a failed command: its error in full beside its exit code and output', async () => {
        const g = genie();
        const cmd = nodeCommand("process.stdout.write('2 failed');process.exit(2)");
        const id = await save(g, 'broken', [manual, node('c', 'genie/terminal_run', { workspace: WS, command: cmd }, 200)], [edge('t', 'c')]);
        let pid: number | null = null;
        const off = g.services.supervisor.onChange((s) => { if (s.id === `flow-run:${id}` && s.pid !== null) pid = s.pid; });
        const run = await runNow(g, id);
        off();
        expect(pid).not.toBeNull();
        expect(run.outcome).toBe('failed');
        // The executor's abort, in the engine's words, as the run's reason says it.
        expect(step(run, 'c')!.error).toBe(`${cmd} ended with exit code 2`);
        expect(step(run, 'c')!.error).toBe(run.reason);
        expect(step(run, 'c')).toMatchObject({ command: { command: cmd, exitCode: 2, output: `[genie] started (pid ${pid}): ${cmd}\n2 failed\n[genie] exited with code 2` } });
    });
});
