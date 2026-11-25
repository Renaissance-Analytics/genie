import { confinePathSync, OutsideWorkspaceError } from './workspace-confine.js';
import { getNodeKind, runFlow, type NodeExecutor } from '@particle-academy/fancy-flow/engine';
import { canonicalKind, type NodeOutcome } from '../core/flow-canvas.js';
import type { FlowRunStepDetail } from '../core/flow-run-review.js';
import { stepLabel } from '../core/flow-reach.js';
import type { Resolution } from '../core/inbox.js';
import { genieExecutors, type FlowPorts, type PromptDelivery, type PromptHooks, type PromptOptions } from './flow-executors.js';
import { importFlowDocument } from './flow-kinds.js';
import type { RunControl, RunResult } from './flow-scheduler.js';
import type { FileFired, FlowRecord, FlowRunStep, Schedule, StationFired } from './flow-store.js';
import type { ProcessStatus, ProcessSupervisor } from './process-supervisor.js';

/**
 * FLOWS (§6.6) — THE RUNNER: what happens when a flow fires (hosting ship line P4).
 *
 * The scheduler decides WHEN; this executes the flow's document on fancy-flow's own engine
 * (`runFlow`), with Genie's executors (flow-executors.ts) behind real ports:
 * - `genie/terminal_run` runs its command as a SUPERVISED process (`supervisedCommand`), so its output
 *   is kept by the supervisor exactly like a background process's log (P1) — readable in Hosting →
 *   Processes and through the agents' `processes logs` after the run, failed or not;
 * - `genie/agent_prompt` hands the named agent its prompt — mid-turn where the provider reads one — and is done then, or
 *   waits for the agent's reply when the step asks to (`agentPrompter`, Tynn #826);
 * - `genie/knowledge_add` writes into the knowledge graph.
 *
 * Each run answers an OUTCOME the store records: it RAN, it FAILED with the reason (the engine's words,
 * an executor's abort, a non-zero exit), or it was HELD back — with why — because:
 * - the flow's workspace is hibernated (nothing runs there until it is woken, Genie 1's genie#672);
 * - the target agent is mid-turn and the port cannot hand it a message (a port with no `deliver`);
 * - the flow's previous command is still running.
 * A held-back step is not retried: the next scheduled run is the next chance, as Genie 1's skipped runs were.
 */

/**
 * THE CONDITION a routing step read, in its own terms (Tynn #839): a branch's expression, or its rows with how they
 * combine; a switch's value. `undefined` for a step whose config names none (a question chooses by the person's answer).
 */
export function conditionWords(config: Readonly<Record<string, unknown>>): string | undefined {
    for (const k of ['expression', 'condition']) {
        const v = config[k];
        if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
    if (Array.isArray(config.conditions) && config.conditions.length > 0) {
        const rows = config.conditions.map((row) => {
            const r = (row ?? {}) as Record<string, unknown>;
            return [r.left, r.operator ?? r.op, r.right].filter((x) => x !== undefined && x !== '').map(String).join(' ');
        });
        return `${config.match === 'any' ? 'any' : 'all'}: ${rows.join('; ')}`;
    }
    if (typeof config.value === 'string' && config.value.trim() !== '') return `value ${config.value.trim()}`;
    return undefined;
}

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

/**
 * What a run tells its watcher AS IT GOES (genie#1204): every node's outcome so far — so the scheduler can keep the run
 * in flight on disk (a quit mid-run is recorded, never lost) and the canvas can draw it — and each Log node's line.
 */
export interface RunObserver {
    readonly nodes?: (outcomes: Record<string, NodeOutcome>) => void;
    readonly log?: (nodeId: string, line: string) => void;
    /** The run's step is paused at its agent's provider limit (Tynn #749), or goes again (`null`): kept with the run in flight, shown as Paused. */
    readonly paused?: (info: { resumesAtMs: number | null; agentId: string; agent: string } | null) => void;
    /** Each step's output as it finishes (genie#1204): kept with the run in flight, so a quit can resume after it. */
    readonly output?: (nodeId: string, value: unknown) => void;
    /**
     * What each step did, as it goes (Tynn #839): its start and end, its error, and by kind the command (exit code, this
     * run's output, its process), the prompt (text, recipient, delivery, reply) or the way a branch went. A patch: the
     * watcher folds it into what the step had (`mergeStep`).
     */
    readonly step?: (nodeId: string, patch: Partial<FlowRunStepDetail>) => void;
}

/** Resume a run Genie quit under (genie#1204): the outputs of the steps it had done, handed on, not run again. */
export interface RunResume {
    readonly outputs: Readonly<Record<string, unknown>>;
}

/** The scheduler's `run`: one run of a flow, answering its outcome. Never throws. */
/** A step let go because its run was STOPPED (Tynn #833). Never a failure: the run is recorded stopped. */
class StoppedRun extends Error {
    override readonly name = 'StoppedRun';
}

export function createFlowRunner(deps: FlowRunnerDeps): (flow: FlowRecord, trigger: Schedule | FileFired | StationFired | null, observer?: RunObserver, resume?: RunResume, control?: RunControl) => Promise<RunResult> {
    const now = deps.now ?? Date.now;
    return async (flow, trigger, observer, resume, control) => {
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
        // What became of each agent prompt, by its node (Tynn #826): a step that did not wait for the reply
        // reads `delivered` (handed over or accepted) or `waiting` (kept for the agent's next run), not `ran`.
        const delivered = new Map<string, NodeOutcome>();
        // The step paused at its agent's provider limit (Tynn #749), while it is: the run keeps its place and its inputs.
        let paused: { resumesAtMs: number | null; agentId: string; agent: string } | null = null;
        const watch = <T>(p: Promise<T>): Promise<T> =>
            p.catch((error: unknown) => {
                if (error instanceof HeldBack) step.held ??= error.message;
                throw error;
            });
        const base = deps.ports(flow);
        /*
         * STOP (Tynn #833): the engine's own abort is looked at only BETWEEN steps, so the step a run is on is let go here —
         * every step races the stop — and the flow's command is killed (its supervised process stopped). Nothing after it
         * runs; the run answers `stopped`.
         */
        const signal = control?.signal;
        const stopped = new Promise<never>((_, reject) => {
            if (!signal) return;
            const stop = (): void => {
                try { base.stopCommand?.(); } catch { /* the step is let go below either way */ }
                reject(new StoppedRun('the run was stopped'));
            };
            if (signal.aborted) stop();
            else signal.addEventListener('abort', stop, { once: true });
        });
        stopped.catch(() => {});
        const isStopped = (): boolean => signal?.aborted === true;
        const ports: FlowPorts = {
            // What became of the prompt is the run's log (Tynn #826): delivered mid-turn, accepted for the turn's end, kept.
            promptAgent: (address, text, hooks, options) => watch(base.promptAgent(address, text, {
                delivered: (how, note) => { observer?.log?.('', note); hooks?.delivered?.(how, note); },
                paused: (info) => {
                    paused = info;
                    if (info !== null) observer?.log?.('', `paused: ${info.agent} is at its provider limit${info.resumesAtMs !== null ? `; it resumes at ${new Date(info.resumesAtMs).toISOString()}` : ''}`);
                    observer?.paused?.(info);
                    observer?.nodes?.(outcomes(false));
                    hooks?.paused?.(info);
                },
            }, options)),
            runCommand: (workspaceId, command, cwd) => watch(base.runCommand(workspaceId, command, cwd)),
            addKnowledge: (input) => watch(base.addKnowledge(input)),
            ...(base.moveFile ? { moveFile: (workspaceId: string, from: string, to: string) => watch(base.moveFile!(workspaceId, from, to)) } : {}),
            ...(base.sleep ? { sleep: base.sleep } : {}),
            // A Wait counts on the run's own clock (genie#1260).
            now,
            ...(base.callTool ? { callTool: (tool: string, args: Record<string, unknown>) => watch(base.callTool!(tool, args)) } : {}),
            ...(base.awaitQuestion ? { awaitQuestion: base.awaitQuestion } : {}),
        };
        const firedAt = new Date(now()).toISOString();
        // The schedule trigger is host-implemented in fancy-flow: it hands its downstream what fired.
        const schedule = trigger !== null && 'cron' in trigger ? trigger : null;
        const trig = () => ({ cron: schedule?.cron ?? '', timezone: schedule?.timezone ?? 'local', firedAt });
        // A file run (genie#1204): its trigger hands the steps after it the file that landed — {{in.path}} and the rest.
        const file = trigger !== null && 'file' in trigger ? trigger.file : null;
        const fileTrig = () => ({ ...(file ?? {}), firedAt });
        // A station run (P9): its trigger hands on the mail that crossed — {{in.direction}}, {{in.address}} and the rest.
        const crossed = trigger !== null && 'station' in trigger ? trigger.station : null;
        const stationTrig = () => ({ ...(crossed ?? {}), firedAt });
        // WHAT EACH STEP DID (Tynn #839), told as it goes: the ports a step calls are that step's own, so the command it ran
        // (exit code, this run's output, its process) and the prompt it sent (text, recipient, delivery, reply) are its.
        const tell = (nodeId: string, patch: Partial<FlowRunStepDetail>): void => { observer?.step?.(nodeId, patch); };
        const portsFor = (nodeId: string): FlowPorts => ({
            ...ports,
            runCommand: async (workspaceId, command, cwd) => {
                tell(nodeId, { command: { command, ...(cwd ? { cwd } : {}) } });
                const r = await ports.runCommand(workspaceId, command, cwd);
                tell(nodeId, { command: { command, exitCode: r.exitCode, output: r.output, ...(r.processId ? { processId: r.processId } : {}) } });
                return r;
            },
            promptAgent: async (address, text, hooks, options) => {
                tell(nodeId, { prompt: { agent: address, text } });
                const reply = await ports.promptAgent(address, text, {
                    ...hooks,
                    delivered: (how, note) => {
                        tell(nodeId, { prompt: { agent: address, text, delivery: how, deliveredAt: new Date(now()).toISOString() } });
                        hooks?.delivered?.(how, note);
                    },
                }, options);
                if (options?.waitForReply === true && typeof reply === 'string') tell(nodeId, { prompt: { agent: address, text, reply } });
                return reply;
            },
        });
        const ownWith = (p: FlowPorts): Record<string, NodeExecutor> => ({ ...genieExecutors(p), '@particle-academy/schedule_trigger': trig, '@particle-academy/manual_trigger': trig, 'genie/file_added': fileTrig, 'genie/station_mail': stationTrig });
        const own = ownWith(ports);
        // Every step's output is told as it finishes (genie#1204) — fancy-flow's own logic steps too, through their kinds'
        // executors — so the run in flight holds what a resume hands on. Keyed by every id a node's kind answers to.
        const executors: Record<string, NodeExecutor> = { ...own };
        for (const node of graph.nodes) {
            const declared = String(((node.data ?? {}) as { kind?: unknown }).kind ?? node.type ?? '');
            const def = getNodeKind(declared);
            const key = own[def?.name ?? declared] ? (def?.name ?? declared) : own[declared] ? declared : null;
            const fallback = key !== null ? own[key] : def?.executor;
            if (!fallback) continue;
            const prompts = canonicalKind(def?.name ?? declared) === 'genie/agent_prompt';
            const wrapped: NodeExecutor = async (ctx) => {
                // A Genie step runs on ITS node's ports (the map is keyed by kind; the node is known only now).
                const base = key !== null ? ownWith(portsFor(ctx.node.id))[key]! : fallback;
                const value = signal ? await Promise.race([base(ctx), stopped]) : await base(ctx);
                // The way a branch, a switch or a question went, and the condition it read (Tynn #839).
                const port = (value as { __port?: unknown } | null)?.__port;
                if (typeof port === 'string') {
                    const condition = conditionWords(((ctx.node.data ?? {}) as { config?: Record<string, unknown> }).config ?? {});
                    tell(ctx.node.id, { route: { port, ...(condition !== undefined ? { condition } : {}) } });
                }
                if (prompts) {
                    const how = (value as { delivery?: unknown } | null)?.delivery;
                    if (how === 'delivered' || how === 'accepted') delivered.set(ctx.node.id, 'delivered');
                    else if (how === 'waiting') delivered.set(ctx.node.id, 'waiting');
                }
                observer?.output?.(ctx.node.id, value);
                return value;
            };
            for (const id of new Set([declared, def?.name ?? declared, ...(def?.aliases ?? [])])) executors[id] = wrapped;
        }
        // From the trigger that fired, so another entry point's branch does not run with it; none named → every entry.
        const fired = trigger?.nodeId ?? null;
        const entry = fired !== null && graph.nodes.some((n) => n.id === fired) ? { entryNodes: [fired] } : {};
        // Each node's last status, from the engine's own events: what a stopped run says it got through (genie#1204).
        const statuses = new Map<string, string>();
        const skipped = new Set<string>();
        // Every node that takes part in the run (an annotation or a lane never does), each 'not reached' until it is.
        const runnable = graph.nodes.filter((n) => {
            const kind = canonicalKind(String(((n.data ?? {}) as { kind?: unknown }).kind ?? n.type ?? ''));
            return kind !== '@particle-academy/note' && kind !== '@particle-academy/lane';
        });
        const outcomes = (final: boolean): Record<string, NodeOutcome> =>
            Object.fromEntries(runnable.map((n) => {
                const status = statuses.get(n.id);
                const o: NodeOutcome = status === 'done' ? (delivered.get(n.id) ?? 'ran')
                    : skipped.has(n.id) ? 'skipped'
                    : final && isStopped() && (status === 'error' || status === 'running') ? 'stopped'
                    : status === 'error' ? (step.held !== null ? 'held' : 'failed')
                    : status === 'running' ? (final ? (step.held !== null ? 'held' : 'failed') : paused !== null ? 'paused' : 'running')
                    : 'not reached';
                return [n.id, o];
            }));
        const onEvent = (event: { type: string; nodeId?: string; status?: string; text?: string; message?: string }) => {
            if (event.type === 'node-status' && typeof event.nodeId === 'string' && typeof event.status === 'string') {
                // Each step's start and end, and its error in the engine's words (Tynn #839). A step a resume handed on
                // ("done", "resumed") did not run in this run, so it has no times here.
                const at = new Date(now()).toISOString();
                if (event.status === 'running' && statuses.get(event.nodeId) !== 'running') tell(event.nodeId, { startedAt: at });
                else if (event.status === 'done' && event.text !== 'resumed') tell(event.nodeId, { endedAt: at });
                else if (event.status === 'error') tell(event.nodeId, { endedAt: at, ...(typeof event.text === 'string' ? { error: event.text } : {}) });
                statuses.set(event.nodeId, event.status);
                if (event.status === 'idle' && event.text === 'skipped') skipped.add(event.nodeId);
                observer?.nodes?.(outcomes(false));
            }
            if (event.type === 'log' && typeof event.nodeId === 'string' && typeof event.message === 'string' && statuses.get(event.nodeId) === 'running') observer?.log?.(event.nodeId, event.message);
        };
        const finish = <T>(result: T): T => { observer?.nodes?.(outcomes(true)); return result; };
        const stepsOf = (): FlowRunStep[] =>
            graph.nodes
                .map((n) => ({ id: n.id, data: (n.data ?? {}) as { kind?: unknown; config?: Record<string, unknown> } }))
                .filter(({ data }) => typeof data.kind === 'string' && !/trigger$/.test(data.kind) && data.kind !== 'genie/file_added' && data.kind !== 'genie/station_mail')
                .map(({ id, data }) => {
                    const status = statuses.get(id);
                    const outcome: FlowRunStep['outcome'] = status === 'done' ? 'ran' : status === 'error' || status === 'running' ? (step.held !== null ? 'held' : 'failed') : 'not reached';
                    return { nodeId: id, label: stepLabel(data), outcome };
                });
        const stoppedResult = (): RunResult => {
            const by = control?.stoppedBy() ?? 'you';
            return finish({ outcome: 'stopped', reason: by === 'you' ? 'stopped by you' : `stopped by ${by}`, stoppedBy: by });
        };
        try {
            const result = await runFlow(graph, executors as never, onEvent as never, { ...entry, run: `${flow.id}:${firedAt}`, ...(resume ? { resumeOutputs: { ...resume.outputs } } : {}), ...(signal ? { signal } : {}) });
            if (isStopped()) return stoppedResult();
            if (result.ok) return finish({ outcome: 'ran' });
            if (step.held !== null) return finish({ outcome: 'held', reason: step.held, steps: stepsOf() });
            return finish({ outcome: 'failed', reason: result.error ?? 'the run failed and the engine gave no reason', steps: stepsOf() });
        } catch (error) {
            if (isStopped()) return stoppedResult();
            if (step.held !== null) return finish({ outcome: 'held', reason: step.held, steps: stepsOf() });
            return finish({ outcome: 'failed', reason: error instanceof Error ? error.message : String(error), steps: stepsOf() });
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
            // The SHARED check (genie#1354, workspace-confine.ts): lexical, then after links; the workspace itself is a folder.
            let dir: string;
            try {
                dir = confinePathSync(root, cwd ?? '.', `"${command}" was not run`, { allowRoot: true });
            } catch (error) {
                reject(error instanceof OutsideWorkspaceError ? new Error(`the folder ${cwd} is outside the workspace ${root}; "${command}" was not run`) : error);
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
                    resolveRun({ exitCode: s.exitCode ?? -1, output: after.startsWith(logBefore) ? after.slice(logBefore.length) : after, processId: run.processId });
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

/**
 * THE LIMIT AN AGENT IS UNDER, as the host reports it (core/rate-limit-gate.ts GateView; session-host.ts `#limitOf`): `open`,
 * `paused` until a reset, `retrying` on a stated backoff, or `needs-person`. Anything but `open` is a PAUSE for a flow (Tynn #749).
 */
export interface AgentLimitView {
    readonly state: string;
    readonly resumeAtMs?: number;
    readonly nextTryAtMs?: number;
}

/** The live sessions, as the runner needs them (main.ts wires the session host). */
export interface AgentSessionsPort {
    session(agentId: string): { readonly running: boolean; readonly turnState: string; readonly pendingApproval?: unknown; readonly limit?: AgentLimitView | undefined; readonly background?: number | null | undefined } | null;
    /**
     * Start an agent that is not running, for a prompt (q_04ce323c: a flow's prompt is work, and work starts it) — main's
     * start-on-demand, refusing an asleep workspace or the agent cap. `false` = not started. Absent = never started here.
     */
    /** May answer later: the agent engine in genie-host answers its start asynchronously. */
    start?(agentId: string): boolean | Promise<boolean>;
    /** This run's ledger rows; their `event` is a stream event. */
    rows(agentId: string): readonly { readonly event: unknown }[];
    prompt(agentId: string, text: string, by: string): boolean | Promise<boolean>;
    /** Whether a prompt `deliver` answered held (`{ id }`) is still held, waiting for a turn. */
    isQueued?(agentId: string, promptId: string): boolean;
    /**
     * HAND A FLOW'S PROMPT TO THE AGENT NOW (Tynn #826; `SessionHost.deliverFlowPrompt`): into the running turn where its
     * provider takes a message mid-turn (Claude), else held by the session for that turn's end (Codex). `{ id: null }` = the
     * agent has it; `{ id }` = held under that id (`isQueued`); `null` = no session to take it. `replacing`: a prompt this
     * flow handed earlier that is still held — dropped first, so one waits, never two.
     */
    deliver?(agentId: string, text: string, by: string, replacing: string | null): { readonly id: string | null } | null | Promise<{ readonly id: string | null } | null>;
    /** KEEP a prompt no run can take (Tynn #826; `SessionHost.keepFlowPrompt`): owed in the agent's thread, replacing this flow's earlier one. */
    keep?(agentId: string, text: string, by: string): void | Promise<void>;
    /**
     * Send what this agent is owed from the senders `only` accepts (Tynn #826; `SessionHost.deliverOwed`): a flow's prompts
     * kept, or held when a run ended. Answers how many.
     */
    deliverKept?(agentId: string, only: (by: string | null) => boolean): Promise<number>;
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
    /** The wait's timer (`FLOW_TURN_QUIET_MS`): fire after `ms`, answering its cancel. Absent = `setTimeout`. */
    readonly after?: (ms: number, fire: () => void) => () => void;
}

/**
 * HOW LONG A FLOW WAITS FOR AN AGENT'S REPLY, when its step asks to (`waitForReply`; Tynn #684, genie#721). The wait used to
 * have no bound: a turn whose end never reached Genie held the run open, and the scheduler held every later run back ("the
 * previous run is still going") for 11 hours. The end not arriving is fixed where it was lost (core/session.ts
 * `#endHeldTurn`); this is the safety net for anything else that ever loses one.
 *
 * QUIET: nothing new in the agent's ledger — no reply, thought, tool call or notice, and no line added to one — for half
 * an hour. MAX: two hours of windows, whatever they show, so a turn that keeps talking but never ends cannot hold a flow
 * for a day. A window in which the agent was at a provider limit (Tynn #749) or had a BACKGROUND job running (Tynn #826:
 * a turn waiting forty minutes on its job writes nothing while it is plainly working) is not counted at all. Either way
 * the run fails in words, the agent's turn is left alone, and the next scheduled run is the next chance.
 */
export const FLOW_TURN_QUIET_MS = 30 * 60_000;
export const FLOW_TURN_MAX_MS = 2 * 60 * 60_000;
const NEEDS_PERSON = (name: string): string => `${name}'s provider needs you (credits or a sign-in) before it can go on: no timer ends that limit, so the flow stopped waiting`;

/** Who a flow's prompt is from, as the agent's thread records it: the flow, by name (Genie 1's genie#543: name the task). */
export const flowSender = (flowName: string): string => `flow "${flowName}"`;
/** Whether a prompt in an agent's thread is a flow's (`flowSender`): what the agent's next run is owed from flows (Tynn #826). */
export const isFlowSender = (by: string | null): boolean => by !== null && /^flow "[\s\S]*"$/.test(by);

/** The prompts flows handed that a provider still holds for a turn's end, by agent and flow: a flow firing again replaces its own. */
const HELD_FLOW_PROMPTS = new Map<string, { promptId: string; supersede: () => void }>();

/**
 * THE NEXT RUN DELIVERS WHAT WAS KEPT (Tynn #826): each time an agent is seen running after it was not — started by the
 * person, by its mail, by a flow, or brought back by a Genie restart — the flow prompts its thread owes it (kept by a step
 * that found no run to take them, or held by a run that then ended) are sent, in order. Only the flows': the person's own
 * drafts stay theirs to Send or Discard. Answers its stop.
 */
export function deliverKeptOnNextRun(sessions: AgentSessionsPort): () => void {
    const deliverKept = sessions.deliverKept;
    if (!deliverKept) return () => {};
    const running = new Set<string>();
    return sessions.subscribe((agentId) => {
        if (sessions.session(agentId)?.running !== true) { running.delete(agentId); return; }
        if (running.has(agentId)) return;
        running.add(agentId);
        // A delivery that fails leaves what is owed owed: the next run, or the person's Restart, sends it.
        void deliverKept(agentId, isFlowSender).catch(() => {});
    });
}

/**
 * `genie/agent_prompt` on a live session (Tynn #826, after Genie 1, whose flows told an agent with an inbox message and
 * were done once it was handed over): resolve the address, refuse what cannot be prompted, HOLD BACK what must not be
 * prompted now (a hibernated workspace), PAUSE while the agent is at its provider limit (Tynn #749), then HAND IT OVER:
 * - an idle agent: a new turn with the prompt;
 * - a BUSY agent (mid-turn, or waiting on an approval): as a typed message goes — into the running turn where the provider
 *   reads one mid-turn (Claude), held by the session for that turn's end where it refuses one (Codex). The same flow firing
 *   again while its earlier prompt is still held REPLACES it: one waits, never two;
 * - NO RUN TO TAKE IT (not running and not startable, or it stopped before the prompt went): KEPT in the agent's thread,
 *   and its next run gets it (`deliverKeptOnNextRun`). Not a failure: the step reads waiting.
 * The step is done then — `delivered`, `accepted` or `waiting` (hooks.delivered) — with no reply. `waitForReply` waits on
 * for the turn the prompt went into (or its own turn, once a held one goes) to end and answers what the agent said,
 * bounded by FLOW_TURN_QUIET_MS / FLOW_TURN_MAX_MS.
 */
export function agentPrompter(deps: AgentPrompterDeps): FlowPorts['promptAgent'] {
    return async (address, text, hooks?: PromptHooks, options?: PromptOptions) => {
        const wait = options?.waitForReply === true;
        const found = deps.resolve(address);
        if (found.kind === 'none') throw new Error(`no agent answers to ${address}`);
        if (found.kind === 'human') throw new Error(`${address} is the person, not an agent; a flow prompts an agent`);
        if (found.kind === 'ambiguous') throw new Error(`${address} names more than one agent (${found.forms.join(', ')}); use the full form`);
        const id = found.id as string;
        const who = deps.agent(id);
        const name = who?.name ?? address;
        if (who && deps.asleep(who.workspaceId)) throw new HeldBack(`${name}'s workspace is hibernated; the prompt was not delivered`);
        const said = (how: PromptDelivery, note: string): void => { hooks?.delivered?.(how, note); };
        /** Nothing can take it now: KEPT for the agent's next run when the port can keep; otherwise the failure, in words. */
        const keep = async (why: string): Promise<string> => {
            if (!deps.sessions.keep) throw new Error(why);
            await deps.sessions.keep(id, text, deps.by);
            said('waiting', `waiting: ${why}; the prompt is kept and goes when ${name} next runs`);
            return '';
        };
        /*
         * A PROVIDER LIMIT IS A PAUSE (Tynn #749): the agent is held, not broken, and Genie resumes it at the reset. So a
         * limited agent is never a finished turn (it reads idle while held), and the time spent waiting is not time the step
         * is judged by. `limitSeen` / `backgroundSeen`: a limit or a background job showed itself since the last quiet window.
         */
        let limitSeen = false;
        let backgroundSeen = false;
        let announced = false;
        const limitOf = (): AgentLimitView | null => {
            const l = deps.sessions.session(id)?.limit;
            return l !== undefined && l.state !== 'open' ? l : null;
        };
        const inBackground = (): boolean => (deps.sessions.session(id)?.background ?? 0) > 0;
        const pauseNote = (l: AgentLimitView | null): void => {
            if (l !== null) limitSeen = true;
            if ((l !== null) === announced) return;
            announced = l !== null;
            hooks?.paused?.(l === null ? null : { resumesAtMs: l.resumeAtMs ?? l.nextTryAtMs ?? null, agentId: id, agent: name });
        };
        let session = deps.sessions.session(id);
        // NOT RUNNING: started for this prompt when the port can (q_04ce323c); its prompt then waits for the start.
        if ((!session || !session.running) && (await deps.sessions.start?.(id))) session = deps.sessions.session(id);
        if (!session || !session.running) return keep(`${name} is not running`);
        // ALREADY AT ITS LIMIT: the step PAUSES (Tynn #749) and the prompt goes when the limit has reset. A limit no timer ends
        // (credits, a sign-in) is the person's. The agent stopping meanwhile keeps the prompt for its next run.
        if (limitOf() !== null) {
            let off: () => void = () => {};
            let gone = false;
            try {
                await new Promise<void>((done, fail) => {
                    const check = (): void => {
                        const s = deps.sessions.session(id);
                        if (s === null || !s.running) { gone = true; done(); return; }
                        const l = limitOf();
                        if (l !== null && l.state === 'needs-person') { fail(new Error(NEEDS_PERSON(name))); return; }
                        pauseNote(l);
                        if (l === null) done();
                    };
                    off = deps.sessions.subscribe((agentId) => { if (agentId === id) check(); });
                    check();
                });
            } finally {
                off();
                pauseNote(null);
            }
            session = deps.sessions.session(id);
            if (gone || !session || !session.running) return keep(`${name} stopped before the prompt could be delivered`);
        }
        const busy = session.turnState === 'working' || (session.pendingApproval !== null && session.pendingApproval !== undefined);
        const after = deps.after ?? ((ms: number, fire: () => void) => { const t = setTimeout(fire, ms); return () => clearTimeout(t); });
        const mark = (): { n: number; last: unknown } => { const r = deps.sessions.rows(id); return { n: r.length, last: r[r.length - 1] }; };
        // THE BOUND (FLOW_TURN_QUIET_MS): checked once per quiet window — a window with a new ledger row is a turn still
        // working, one without is not; a window with a limit or a background job in it is not counted at all.
        const bound = (giveUp: (error: Error) => void, off: () => void): (() => void) => {
            let seen = mark();
            let waited = 0;
            let cancel: () => void = () => {};
            const watch = (): void => {
                cancel = after(FLOW_TURN_QUIET_MS, () => {
                    if (limitOf() !== null || limitSeen || inBackground() || backgroundSeen) {
                        limitSeen = limitOf() !== null;
                        backgroundSeen = inBackground();
                        seen = mark();
                        watch();
                        return;
                    }
                    waited += FLOW_TURN_QUIET_MS;
                    const now = mark();
                    const quiet = now.n === seen.n && now.last === seen.last;
                    seen = now;
                    if (!quiet && waited < FLOW_TURN_MAX_MS) { watch(); return; }
                    off();
                    giveUp(new Error(quiet
                        ? `${name}'s turn did not end: nothing new came from it for ${FLOW_TURN_QUIET_MS / 60_000} minutes. The flow stopped waiting for it; the next run will try again.`
                        : `${name}'s turn did not end within ${FLOW_TURN_MAX_MS / 3_600_000} hours. The flow stopped waiting for it; the next run will try again.`));
                });
            };
            watch();
            return () => cancel();
        };
        // Where the reply starts in the ledger: what comes after the prompt was handed over (moved to its own turn's marker
        // when a held prompt goes as its own turn).
        let from = deps.sessions.rows(id).length;
        // Set once the prompt is in the agent's hands or its session's; `heldId` while the session holds it for a turn's end.
        let sent = false;
        let heldId: string | null = null;
        let leftQueue = false;
        let superseded = false;
        let off: () => void = () => {};
        let recheck: () => void = () => {};
        let giveUp: (error: Error) => void = () => {};
        /*
         * WAITING FOR THE REPLY (the option) is WATCHED FROM BEFORE THE PROMPT GOES: the prompt may answer later (the agent
         * engine in genie-host), and by then its turn can have begun AND ended. `kept`: a held prompt whose agent stopped —
         * the session kept it for the next run, and the step reads waiting.
         */
        const finished = !wait ? null : new Promise<'replied' | 'kept'>((done, fail) => {
            giveUp = fail;
            // A prompt handed into a running turn belongs to that turn: its end hands on the reply.
            let began = busy;
            const check = (): boolean => {
                const s = deps.sessions.session(id);
                if ((s?.background ?? 0) > 0) backgroundSeen = true;
                if (!sent) {
                    if (s?.turnState === 'working' || deps.sessions.rows(id).slice(from).some((r) => (r.event as { kind?: unknown }).kind === 'turn')) began = true;
                    return false;
                }
                if (superseded) { fail(new HeldBack(`${name}: this prompt was replaced by a later fire of ${deps.by} while it was still held, so it never went; the later one goes in its place`)); return true; }
                if (heldId !== null && !leftQueue) {
                    if (s === null || !s.running) { done('kept'); return true; }
                    pauseNote(limitOf());
                    if (deps.sessions.isQueued?.(id, heldId) === true) return false;
                    // It went, as its own turn: the reply is that turn's, from its marker.
                    leftQueue = true;
                    began = false;
                    const ledger = deps.sessions.rows(id);
                    const own = ledger.findIndex((r, i) => i >= from && (r.event as { kind?: unknown; by?: unknown }).kind === 'turn' && (r.event as { by?: unknown }).by === deps.by);
                    from = own >= 0 ? own : ledger.length;
                }
                if (s?.turnState === 'working' || deps.sessions.rows(id).slice(from).some((r) => (r.event as { kind?: unknown }).kind === 'turn')) began = true;
                if (s === null || !s.running) fail(new Error(`${name} stopped before its turn finished`));
                else if (s.turnState === 'failed') fail(new Error(`${name}'s turn failed`));
                else if (s.limit !== undefined && s.limit.state !== 'open') {
                    // HELD AT ITS LIMIT: idle is not "done" (the limit cut the turn); the resumed turn's end is.
                    if (s.limit.state === 'needs-person') fail(new Error(NEEDS_PERSON(name)));
                    else { pauseNote(s.limit); return false; }
                } else if (began && s.turnState !== 'working') done('replied');
                else { pauseNote(null); return false; }
                return true;
            };
            off = deps.sessions.subscribe((agentId) => {
                if (agentId === id && check()) off();
            });
            recheck = () => { if (check()) off(); };
        });
        // A rejection that lands before the await below is still the step's: it is not reported as unhandled meanwhile.
        finished?.catch(() => {});
        try {
            if (busy) {
                if (!deps.sessions.deliver) throw new HeldBack(`${name} is busy (mid-turn); the prompt was not delivered, so it never lands inside another turn`);
                const key = `${id}|${deps.by}`;
                const earlier = HELD_FLOW_PROMPTS.get(key);
                const replacing = earlier !== undefined && deps.sessions.isQueued?.(id, earlier.promptId) === true ? earlier : null;
                const handed = await deps.sessions.deliver(id, text, deps.by, replacing?.promptId ?? null);
                if (handed === null) { off(); return await keep(`${name} stopped before the prompt could be delivered`); }
                if (handed.id === null) {
                    said('delivered', `delivered to ${name} mid-turn: it reads the prompt at its next step`);
                } else {
                    heldId = handed.id;
                    HELD_FLOW_PROMPTS.set(key, { promptId: handed.id, supersede: () => { superseded = true; recheck(); } });
                    replacing?.supersede();
                    said('accepted', replacing !== null
                        ? `accepted: ${name}'s provider holds the prompt, and it goes when its current turn ends; it replaced the prompt this flow handed earlier, which had not gone yet`
                        : `accepted: ${name}'s provider holds the prompt, and it goes when its current turn ends`);
                }
            } else {
                const answer = deps.sessions.prompt(id, text, deps.by);
                // An engine that answers at once has already begun the turn: seen now, before anything can end it.
                recheck();
                if (!(await answer)) { off(); return await keep(`${name} stopped before the prompt could be delivered`); }
                said('delivered', `delivered to ${name}`);
            }
        } catch (error) {
            off();
            throw error;
        }
        sent = true;
        if (finished === null) return '';
        recheck();
        const cancelTimer = bound(giveUp, off);
        let ended: 'replied' | 'kept';
        try {
            ended = await finished;
        } finally {
            off();
            cancelTimer();
            pauseNote(null);
        }
        if (ended === 'kept') {
            said('waiting', `waiting: ${name} stopped before the prompt went; the prompt is kept and goes when ${name} next runs`);
            return '';
        }
        return deps.sessions
            .rows(id)
            .slice(from)
            .map((r) => r.event as { kind?: unknown; speaker?: unknown; text?: unknown })
            .filter((e) => e.kind === 'message' && e.speaker === 'agent' && typeof e.text === 'string')
            .map((e) => e.text as string)
            .join('\n');
    };
}
