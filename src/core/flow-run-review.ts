import type { NodeOutcome } from './flow-canvas.js';

/**
 * REVIEWING A FLOW RUN (Tynn #839; the owner, 2026-11-17: "reviewing flow runs needs to give me more info than this. and
 * why waste so much space?"). What one run did, step by step, read from what the run store recorded:
 *
 * - each step's TIMELINE entry (`FlowRunStepDetail`), recorded as the run goes: when it started and ended, the error in
 *   full, and what it did by kind: a command with its exit code and THIS run's output, a prompt with its recipient, its
 *   exact text, when it was delivered and the reply, a branch with its condition and the way it went;
 * - the run's header: what started it, when, how long it took, and who;
 * - the run drawn on the canvas: every node coloured by its outcome and the path the run took highlighted.
 *
 * A run recorded before #839 has none of the timeline and no `startedBy`: what it lacks reads "not recorded", never a
 * guess. Pure, so the window, the tests and an agent's tool read a run the same way.
 */

/** One step of a run, as recorded (Tynn #839). Every field is optional: a step records what it got to. */
export interface FlowRunStepDetail {
    readonly nodeId: string;
    /** When the engine started the step, and when it ended (ISO). */
    readonly startedAt?: string;
    readonly endedAt?: string;
    /** Why the step failed, in full (an executor's abort, the engine's words, a held-back step's reason). */
    readonly error?: string;
    /** A command step: what ran, where, its exit code, THIS run's output (its tail, bounded) and the process that keeps the whole log. */
    readonly command?: {
        readonly command: string;
        readonly cwd?: string;
        readonly exitCode?: number;
        readonly output?: string;
        /** Characters cut from the front of `output` by the bound. */
        readonly outputCut?: number;
        /** The supervised process whose kept log holds every run's output (Hosting → Processes; `processes logs <id>`). */
        readonly processId?: string;
    };
    /** An agent-prompt step: to whom, the exact text sent, what became of it and when, and the reply when the step waited for it. */
    readonly prompt?: {
        readonly agent: string;
        readonly text: string;
        readonly delivery?: string;
        readonly deliveredAt?: string;
        readonly reply?: string;
    };
    /** A step that chose a way (a branch, a switch, a question): the port it took and the condition it read. */
    readonly route?: { readonly port: string; readonly condition?: string };
}

/** What a run without it says. */
export const NOT_RECORDED = 'not recorded';
/** How much of a command's output one step keeps (its tail): the whole log stays with the process. */
export const STEP_OUTPUT_LIMIT = 16_000;
/** How much of a prompt, a reply or an error one step keeps. */
export const STEP_TEXT_LIMIT = 8_000;

/** A step's patch folded into what it had: later fields win, and `command` / `prompt` / `route` merge field by field. */
export function mergeStep(prev: FlowRunStepDetail, patch: Partial<FlowRunStepDetail>): FlowRunStepDetail {
    const { command, prompt, route, ...flat } = patch;
    return {
        ...prev,
        ...flat,
        nodeId: prev.nodeId,
        ...(command ? { command: { ...prev.command, ...command } } : {}),
        ...(prompt ? { prompt: { ...prev.prompt, ...prompt } } : {}),
        ...(route ? { route: { ...prev.route, ...route } } : {}),
    };
}

const head = (s: string): string => (s.length > STEP_TEXT_LIMIT ? `${s.slice(0, STEP_TEXT_LIMIT)}…` : s);

/** A step bounded for the store: the output's TAIL (and how much was cut), the prompt, reply and error's head. */
export function boundStepDetail(detail: FlowRunStepDetail): FlowRunStepDetail {
    const { command, prompt, error } = detail;
    let boundedCommand = command;
    if (command?.output !== undefined && command.output.length > STEP_OUTPUT_LIMIT) {
        const cut = command.output.length - STEP_OUTPUT_LIMIT;
        boundedCommand = { ...command, output: command.output.slice(cut), outputCut: (command.outputCut ?? 0) + cut };
    }
    return {
        ...detail,
        ...(error !== undefined ? { error: head(error) } : {}),
        ...(boundedCommand ? { command: boundedCommand } : {}),
        ...(prompt ? { prompt: { ...prompt, text: head(prompt.text), ...(prompt.reply !== undefined ? { reply: head(prompt.reply) } : {}) } } : {}),
    };
}

/** A duration in words: `350 ms`, `4.2 s`, `3 min 05 s`, `1 h 02 min`; `null` = not recorded. */
export function formatDuration(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms) || ms < 0) return NOT_RECORDED;
    if (ms < 1_000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
    const s = Math.floor(ms / 1_000);
    if (s < 3_600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
    return `${Math.floor(s / 3_600)} h ${String(Math.floor((s % 3_600) / 60)).padStart(2, '0')} min`;
}

/** The fields of a run the review reads (FlowRun's, without the main-process import). */
export interface ReviewedRun {
    readonly at: string;
    readonly endedAt: string;
    readonly trigger: 'schedule' | 'manual' | 'file';
    readonly file?: string;
    readonly outcome: string;
    readonly reason?: string;
    readonly nodes?: Readonly<Record<string, NodeOutcome>>;
    readonly timeline?: readonly FlowRunStepDetail[];
    readonly startedBy?: { readonly kind: 'user' } | { readonly kind: 'agent'; readonly id: string; readonly name: string };
    readonly stoppedBy?: string;
    readonly resumed?: true;
}

export interface RunHeader {
    /** What started it, in words. */
    readonly trigger: string;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly durationMs: number | null;
    readonly outcome: string;
    /** Who started it: `you`, an agent's name, Genie for a schedule or a file; `not recorded` for an old Run now. */
    readonly startedBy: string;
    readonly reason?: string;
}

const between = (from: string | undefined, to: string | undefined): number | null => {
    if (from === undefined || to === undefined) return null;
    const ms = Date.parse(to) - Date.parse(from);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

export function runHeader(run: ReviewedRun): RunHeader {
    const trigger = run.trigger === 'manual' ? 'Run now' : run.trigger === 'file' ? `a file was added: ${run.file ?? NOT_RECORDED}` : 'on schedule';
    const startedBy = run.trigger === 'schedule' ? 'Genie (its schedule)'
        : run.trigger === 'file' ? 'Genie (a file was added)'
        : run.startedBy === undefined ? NOT_RECORDED
        : run.startedBy.kind === 'user' ? 'you' : run.startedBy.name;
    return { trigger, startedAt: run.at, endedAt: run.endedAt, durationMs: between(run.at, run.endedAt), outcome: run.outcome, startedBy, ...(run.reason !== undefined ? { reason: run.reason } : {}) };
}

export interface RunRow {
    readonly nodeId: string;
    readonly outcome: NodeOutcome;
    readonly startedAt: string | null;
    readonly durationMs: number | null;
    readonly detail: FlowRunStepDetail | null;
}

/**
 * The run's steps as rows: those that started, in the order they started; then the rest (skipped, not reached), in the
 * graph's order. Only nodes the run has an outcome for (an annotation never does).
 */
export function runRows(graphNodeIds: readonly string[], run: ReviewedRun): RunRow[] {
    const nodes = run.nodes ?? {};
    const details = new Map((run.timeline ?? []).map((d) => [d.nodeId, d]));
    const rows = graphNodeIds
        .filter((id) => nodes[id] !== undefined)
        .map((id, order) => {
            const detail = details.get(id) ?? null;
            return { order, row: { nodeId: id, outcome: nodes[id]!, startedAt: detail?.startedAt ?? null, durationMs: between(detail?.startedAt, detail?.endedAt), detail } };
        });
    const started = rows.filter((r) => r.row.startedAt !== null).sort((a, b) => Date.parse(a.row.startedAt!) - Date.parse(b.row.startedAt!) || a.order - b.order);
    const rest = rows.filter((r) => r.row.startedAt === null);
    return [...started, ...rest].map((r) => r.row);
}

interface EdgeLike { readonly id: string; readonly source: string; readonly target: string; readonly sourceHandle?: string | null }

/** A step that FINISHED, so the run went on from it. */
const FINISHED: ReadonlySet<NodeOutcome> = new Set<NodeOutcome>(['ran', 'delivered', 'waiting']);
/** A step the run never got to. */
const UNREACHED: ReadonlySet<NodeOutcome> = new Set<NodeOutcome>(['skipped', 'not reached']);

/**
 * The edges the run went along: from a step that finished to one it reached, and out of a step that chose a way only
 * along the way it chose.
 */
export function takenEdges(edges: readonly EdgeLike[], run: ReviewedRun): Set<string> {
    const nodes = run.nodes ?? {};
    const ways = new Map((run.timeline ?? []).filter((d) => d.route !== undefined).map((d) => [d.nodeId, d.route!.port]));
    const taken = new Set<string>();
    for (const e of edges) {
        const from = nodes[e.source];
        const to = nodes[e.target];
        if (from === undefined || to === undefined || !FINISHED.has(from) || UNREACHED.has(to)) continue;
        const way = ways.get(e.source);
        if (way !== undefined && e.sourceHandle && e.sourceHandle !== way) continue;
        taken.add(e.id);
    }
    return taken;
}

/** fancy-flow's node run status for an outcome (NodeShell draws it). */
export type ShellStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';
export function shellStatus(outcome: NodeOutcome | undefined): ShellStatus {
    switch (outcome) {
        case 'ran': case 'delivered': return 'done';
        case 'failed': case 'stopped': return 'error';
        case 'running': return 'running';
        case 'held': case 'paused': case 'queued': case 'waiting': return 'queued';
        default: return 'idle';
    }
}

/** An outcome as a class-name word: `not reached` → `not-reached`. */
export const outcomeSlug = (outcome: NodeOutcome): string => outcome.replace(/\s+/g, '-');

interface GraphLike<N, E> { readonly nodes: readonly N[]; readonly edges: readonly E[] }

/**
 * The flow's graph DRAWN AS THE RUN: each node with its outcome (status, a few words and a class to colour it) and
 * selected when it is the step picked; each edge the run took highlighted, the rest faded.
 */
export function runCanvasGraph<N extends { id: string; data?: unknown }, E extends EdgeLike>(graph: GraphLike<N, E>, run: ReviewedRun, selected: string | null): { nodes: N[]; edges: E[] } {
    const outcomes = run.nodes ?? {};
    const rows = new Map(runRows(graph.nodes.map((n) => n.id), run).map((r) => [r.nodeId, r]));
    const taken = takenEdges(graph.edges, run);
    const nodes = graph.nodes.map((n) => {
        const outcome = outcomes[n.id];
        const row = rows.get(n.id);
        const words = outcome === undefined ? undefined : row?.durationMs != null ? `${outcome} · ${formatDuration(row.durationMs)}` : outcome;
        return {
            ...n,
            data: { ...((n.data ?? {}) as Record<string, unknown>), status: shellStatus(outcome), ...(words !== undefined ? { statusText: words } : {}) },
            className: outcome === undefined ? 'genie-run-node genie-run-node--none' : `genie-run-node genie-run-node--${outcomeSlug(outcome)}`,
            selected: n.id === selected,
        } as N;
    });
    const edges = graph.edges.map((e) => ({ ...e, className: taken.has(e.id) ? 'genie-run-edge genie-run-edge--taken' : 'genie-run-edge genie-run-edge--idle', animated: false }) as E);
    return { nodes, edges };
}
