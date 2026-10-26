import { isAbsolute, relative, resolve } from 'node:path';
import { runFlow } from '@particle-academy/fancy-flow/engine';
import { stepLabel } from '../core/flow-reach.js';
import type { Resolution } from '../core/inbox.js';
import { genieExecutors, type FlowPorts } from './flow-executors.js';
import { importFlowDocument } from './flow-kinds.js';
import type { RunResult } from './flow-scheduler.js';
import type { FileFired, FlowRecord, FlowRunStep, Schedule } from './flow-store.js';
import type { ProcessStatus, ProcessSupervisor } from './process-supervisor.js';

/**
 * FLOWS (§6.6) — THE RUNNER: what happens when a flow fires (hosting ship line P4).
 *
 * The scheduler decides WHEN; this executes the flow's document on fancy-flow's own engine
 * (`runFlow`), with Genie's executors (flow-executors.ts) behind real ports:
 * - `genie/terminal_run` runs its command as a SUPERVISED process (`supervisedCommand`), so its output
 *   is kept by the supervisor exactly like a background process's log (P1) — readable in Hosting →
 *   Processes and through the agents' `processes logs` after the run, failed or not;
 * - `genie/agent_prompt` prompts the named agent and waits for its turn to end (`agentPrompter`);
 * - `genie/knowledge_add` writes into the knowledge graph.
 *
 * Each run answers an OUTCOME the store records: it RAN, it FAILED with the reason (the engine's words,
 * an executor's abort, a non-zero exit), or it was HELD back — with why — because:
 * - the flow's workspace is hibernated (nothing runs there until it is woken, Genie 1's genie#672);
 * - the target agent is mid-turn (a scheduled prompt never lands inside someone else's turn);
 * - the flow's previous command is still running.
 * A held-back step is not retried: the next scheduled run is the next chance, as Genie 1's skipped runs were.
 */

/** A step that could not run now for a reason that is not a failure. The run is recorded `held`. */
export class HeldBack extends Error {
    override readonly name = 'HeldBack';
}

export interface FlowRunnerDeps {
    /** The effects for ONE flow's run (its supervised process, its prompt's sender name). */
    readonly ports: (flow: FlowRecord) => FlowPorts;
    /** Hibernated (§6.1): nothing of the workspace runs. */
    readonly asleep: (workspaceId: string) => boolean;
    readonly now?: () => number;
}

/** The scheduler's `run`: one run of a flow, answering its outcome. Never throws. */
export function createFlowRunner(deps: FlowRunnerDeps): (flow: FlowRecord, trigger: Schedule | FileFired | null) => Promise<RunResult> {
    const now = deps.now ?? Date.now;
    return async (flow, trigger) => {
        if (deps.asleep(flow.workspaceId)) {
            return { outcome: 'held', reason: `its workspace ${flow.workspaceId} is hibernated; nothing runs there until it is woken` };
        }
        // The graph is the ENGINE's hydration of the document, read exactly as the store validated it (flow-kinds.ts):
        // a flow stored by an earlier beta that the engine now refuses fails here, in the engine's words, before any step runs.
        const imported = importFlowDocument(flow.document);
        if (!imported.ok) return { outcome: 'failed', reason: `the flow document was refused by the engine: ${imported.problems.join('; ')}` };
        const graph = imported.graph;
        if (graph.nodes.length === 0) return { outcome: 'failed', reason: 'the flow has no steps to run' };
        // A port that holds a step back says so; the engine sees an ordinary failure and stops the run there.
        const step: { held: string | null } = { held: null };
        const watch = <T>(p: Promise<T>): Promise<T> =>
            p.catch((error: unknown) => {
                if (error instanceof HeldBack) step.held ??= error.message;
                throw error;
            });
        const base = deps.ports(flow);
        const ports: FlowPorts = {
            promptAgent: (address, text) => watch(base.promptAgent(address, text)),
            runCommand: (workspaceId, command, cwd) => watch(base.runCommand(workspaceId, command, cwd)),
            addKnowledge: (input) => watch(base.addKnowledge(input)),
            ...(base.moveFile ? { moveFile: (workspaceId: string, from: string, to: string) => watch(base.moveFile!(workspaceId, from, to)) } : {}),
        };
        const firedAt = new Date(now()).toISOString();
        // The schedule trigger is host-implemented in fancy-flow: it hands its downstream what fired.
        const schedule = trigger !== null && 'cron' in trigger ? trigger : null;
        const trig = () => ({ cron: schedule?.cron ?? '', timezone: schedule?.timezone ?? 'local', firedAt });
        // A file run (genie#1204): its trigger hands the steps after it the file that landed — {{in.path}} and the rest.
        const file = trigger !== null && 'file' in trigger ? trigger.file : null;
        const fileTrig = () => ({ ...(file ?? {}), firedAt });
        const executors = { ...genieExecutors(ports), '@particle-academy/schedule_trigger': trig, '@particle-academy/manual_trigger': trig, 'genie/file_added': fileTrig };
        // From the trigger that fired, so another entry point's branch does not run with it; none named → every entry.
        const fired = trigger?.nodeId ?? null;
        const entry = fired !== null && graph.nodes.some((n) => n.id === fired) ? { entryNodes: [fired] } : {};
        // Each node's last status, from the engine's own events: what a stopped run says it got through (genie#1204).
        const statuses = new Map<string, string>();
        const onEvent = (event: { type: string; nodeId?: string; status?: string }) => {
            if (event.type === 'node-status' && typeof event.nodeId === 'string' && typeof event.status === 'string') statuses.set(event.nodeId, event.status);
        };
        const stepsOf = (): FlowRunStep[] =>
            graph.nodes
                .map((n) => ({ id: n.id, data: (n.data ?? {}) as { kind?: unknown; config?: Record<string, unknown> } }))
                .filter(({ data }) => typeof data.kind === 'string' && !/trigger$/.test(data.kind) && data.kind !== 'genie/file_added')
                .map(({ id, data }) => {
                    const status = statuses.get(id);
                    const outcome: FlowRunStep['outcome'] = status === 'done' ? 'ran' : status === 'error' || status === 'running' ? (step.held !== null ? 'held' : 'failed') : 'not reached';
                    return { nodeId: id, label: stepLabel(data), outcome };
                });
        try {
            const result = await runFlow(graph, executors, onEvent as never, { ...entry, run: `${flow.id}:${firedAt}` });
            if (result.ok) return { outcome: 'ran' };
            if (step.held !== null) return { outcome: 'held', reason: step.held, steps: stepsOf() };
            return { outcome: 'failed', reason: result.error ?? 'the run failed and the engine gave no reason', steps: stepsOf() };
        } catch (error) {
            if (step.held !== null) return { outcome: 'held', reason: step.held, steps: stepsOf() };
            return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error), steps: stepsOf() };
        }
    };
}

export interface SupervisedCommandDeps {
    readonly supervisor: Pick<ProcessSupervisor, 'start' | 'status' | 'onChange' | 'readLog'>;
    /** The workspace's folder, or null when it is not registered. */
    readonly workspacePath: (workspaceId: string) => string | null;
    /** The workspace's service env, as a background process gets it. */
    readonly envFor?: (workspaceId: string) => Readonly<Record<string, string>>;
}

/**
 * `genie/terminal_run` through the SUPERVISOR: the command runs as process `processId` (one per flow, so
 * every run's output lands in the same kept log, after the ones before), restart `never`, in the
 * workspace or a folder inside it. Resolves with the exit code and THIS run's output when it exits; a
 * person's Stop rejects; a previous run still going holds this one back.
 */
export function supervisedCommand(deps: SupervisedCommandDeps, run: { processId: string; name: string }): FlowPorts['runCommand'] {
    return (workspaceId, command, cwd) =>
        new Promise((resolveRun, reject) => {
            const root = deps.workspacePath(workspaceId);
            if (root === null) {
                reject(new Error(`workspace ${workspaceId} is not registered here; "${command}" was not run`));
                return;
            }
            const dir = resolve(root, cwd ?? '.');
            const inside = relative(root, dir);
            if (inside.startsWith('..') || isAbsolute(inside)) {
                reject(new Error(`the folder ${cwd} is outside the workspace ${root}; "${command}" was not run`));
                return;
            }
            const before = deps.supervisor.status(run.processId);
            if (before && (before.state === 'running' || before.state === 'restarting')) {
                reject(new HeldBack(`"${run.name}" is still running its previous command; "${command}" was not started beside it`));
                return;
            }
            const logBefore = deps.supervisor.readLog(run.processId)?.text ?? '';
            const off = deps.supervisor.onChange((s: ProcessStatus) => {
                if (s.id !== run.processId) return;
                if (s.state === 'exited' || s.state === 'failed') {
                    off();
                    const after = deps.supervisor.readLog(run.processId)?.text ?? '';
                    resolveRun({ exitCode: s.exitCode ?? -1, output: after.startsWith(logBefore) ? after.slice(logBefore.length) : after });
                } else if (s.state === 'stopped') {
                    off();
                    reject(new Error(`"${command}" was stopped before it finished`));
                }
            });
            try {
                const env = deps.envFor?.(workspaceId);
                deps.supervisor.start({ id: run.processId, workspaceId, name: run.name, command, cwd: dir, restart: 'never', ...(env ? { env } : {}) });
            } catch (error) {
                off();
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
}

/** The live sessions, as the runner needs them (main.ts wires the session host). */
export interface AgentSessionsPort {
    session(agentId: string): { readonly running: boolean; readonly turnState: string; readonly pendingApproval?: unknown } | null;
    /** This run's ledger rows; their `event` is a stream event. */
    rows(agentId: string): readonly { readonly event: unknown }[];
    prompt(agentId: string, text: string, by: string): boolean;
    subscribe(listener: (agentId: string) => void): () => void;
}

export interface AgentPrompterDeps {
    readonly sessions: AgentSessionsPort;
    /** The inbox's own address rule, on the live roster. */
    readonly resolve: (address: string) => Resolution;
    readonly agent: (agentId: string) => { readonly name: string; readonly workspaceId: string } | null;
    readonly asleep: (workspaceId: string) => boolean;
    /** Who the turn is from, as the agent's ledger shows it — the flow, by name (Genie 1's genie#543: name the task). */
    readonly by: string;
}

/**
 * `genie/agent_prompt` on a live session: resolve the address, refuse what cannot be prompted, HOLD BACK
 * what must not be prompted now (a hibernated workspace, an agent mid-turn or waiting on an approval), then
 * prompt and wait for the turn to end. The reply is what the agent said in that turn.
 */
export function agentPrompter(deps: AgentPrompterDeps): FlowPorts['promptAgent'] {
    return async (address, text) => {
        const found = deps.resolve(address);
        if (found.kind === 'none') throw new Error(`no agent answers to ${address}`);
        if (found.kind === 'human') throw new Error(`${address} is the person, not an agent; a flow prompts an agent`);
        if (found.kind === 'ambiguous') throw new Error(`${address} names more than one agent (${found.forms.join(', ')}); use the full form`);
        const id = found.id as string;
        const who = deps.agent(id);
        const name = who?.name ?? address;
        if (who && deps.asleep(who.workspaceId)) throw new HeldBack(`${name}'s workspace is hibernated; the prompt was not delivered`);
        const session = deps.sessions.session(id);
        if (!session || !session.running) throw new Error(`${name} is not running; a scheduled prompt has nowhere to go until it is started`);
        if (session.turnState === 'working' || (session.pendingApproval !== null && session.pendingApproval !== undefined)) {
            throw new HeldBack(`${name} is busy (mid-turn); the prompt was not delivered, so it never lands inside another turn`);
        }
        const from = deps.sessions.rows(id).length;
        if (!deps.sessions.prompt(id, text, deps.by)) throw new Error(`${name} stopped before the prompt could be delivered`);
        await new Promise<void>((done, fail) => {
            let off: () => void = () => {};
            const check = (): boolean => {
                const s = deps.sessions.session(id);
                if (s === null || !s.running) fail(new Error(`${name} stopped before its turn finished`));
                else if (s.turnState === 'failed') fail(new Error(`${name}'s turn failed`));
                else if (s.turnState !== 'working') done();
                else return false;
                return true;
            };
            if (check()) return;
            off = deps.sessions.subscribe((agentId) => {
                if (agentId === id && check()) off();
            });
        });
        return deps.sessions
            .rows(id)
            .slice(from)
            .map((r) => r.event as { kind?: unknown; speaker?: unknown; text?: unknown })
            .filter((e) => e.kind === 'message' && e.speaker === 'agent' && typeof e.text === 'string')
            .map((e) => e.text as string)
            .join('\n');
    };
}
