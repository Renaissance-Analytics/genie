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
        const id = await save(g, 'review', [
            manual,
            node('c', 'genie/terminal_run', { workspace: WS, command: nodeCommand("process.stdout.write('found 3');process.exit(3)"), allowFailure: true }, 200),
            node('b', '@particle-academy/branch', { match: 'all', conditions: [{ left: '{{ $json.exitCode }}', operator: 'eq', right: '3' }] }, 400),
            node('p', 'genie/agent_prompt', { agent: AGENT, prompt: 'look at {{ in.output }}', waitForReply: true }, 600),
            node('n', '@particle-academy/log', { level: 'info', message: 'nothing' }, 600),
        ], [edge('t', 'c'), edge('c', 'b'), edge('b', 'p', 'true'), edge('b', 'n', 'false')]);
        const run = await runNow(g, id);
        expect(run).toMatchObject({ outcome: 'ran', nodes: { c: 'ran', b: 'ran', p: 'ran', n: 'skipped' }, startedBy: { kind: 'user' } });
        expect(step(run, 'c')).toMatchObject({ command: { exitCode: 3, processId: `flow-run:${id}` } });
        expect(step(run, 'c')!.command.output).toContain('found 3');
        expect(step(run, 'b')!.route).toMatchObject({ port: 'true' });
        expect(step(run, 'b')!.route.condition).toContain('{{ $json.exitCode }}');
        // The prompt recorded is EXACTLY the text the agent's live session received (templated from the command's output),
        // and the reply is the agent's answer to it.
        const prompt = step(run, 'p')!.prompt as { agent: string; text: string; reply?: string; deliveredAt?: string };
        expect(prompt.agent).toBe(AGENT);
        expect(g.sessions.prompts.map((x) => x.text)).toEqual([prompt.text]);
        expect(prompt.text).toMatch(/^look at [\s\S]*found 3/);
        expect(prompt.reply).toBe(`atlas did: ${prompt.text}`);
        expect(typeof prompt.deliveredAt).toBe('string');
        for (const s of ['c', 'b', 'p']) expect(Date.parse(step(run, s)!.endedAt)).toBeGreaterThanOrEqual(Date.parse(step(run, s)!.startedAt));
        expect(step(run, 'n')?.startedAt).toBeUndefined();
    });

    it('a failed command: its error in full beside its exit code and output', async () => {
        const g = genie();
        const id = await save(g, 'broken', [manual, node('c', 'genie/terminal_run', { workspace: WS, command: nodeCommand("process.stdout.write('2 failed');process.exit(2)") }, 200)], [edge('t', 'c')]);
        const run = await runNow(g, id);
        expect(run.outcome).toBe('failed');
        expect(step(run, 'c')!.error).toMatch(/ended with exit code 2$/);
        expect(step(run, 'c')).toMatchObject({ command: { exitCode: 2 } });
        expect(step(run, 'c')!.command.output).toContain('2 failed');
    });
});
