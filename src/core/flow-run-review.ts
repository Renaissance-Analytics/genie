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
export function mergeStep(prev: FlowRunStepDetail, _patch: Partial<FlowRunStepDetail>): FlowRunStepDetail {
    return prev;
}

/** A step bounded for the store: the output's TAIL (and how much was cut), the prompt, reply and error's head. */
export function boundStepDetail(detail: FlowRunStepDetail): FlowRunStepDetail {
    return detail;
}

/** A duration in words: `350 ms`, `4.2 s`, `3 min 05 s`, `1 h 02 min`; `null` = not recorded. */
export function formatDuration(_ms: number | null): string {
    return '';
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

export function runHeader(run: ReviewedRun): RunHeader {
    return { trigger: '', startedAt: run.at, endedAt: run.endedAt, durationMs: null, outcome: run.outcome, startedBy: '' };
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
export function runRows(_graphNodeIds: readonly string[], _run: ReviewedRun): RunRow[] {
    return [];
}

interface EdgeLike { readonly id: string; readonly source: string; readonly target: string; readonly sourceHandle?: string | null }

/**
 * The edges the run went along: from a step that finished to one it reached, and out of a step that chose a way only
 * along the way it chose.
 */
export function takenEdges(_edges: readonly EdgeLike[], _run: ReviewedRun): Set<string> {
    return new Set();
}

/** fancy-flow's node run status for an outcome (NodeShell draws it). */
export type ShellStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';
export function shellStatus(_outcome: NodeOutcome | undefined): ShellStatus {
    return 'idle';
}

interface GraphLike<N, E> { readonly nodes: readonly N[]; readonly edges: readonly E[] }

/**
 * The flow's graph DRAWN AS THE RUN: each node with its outcome (status, a few words and a class to colour it) and
 * selected when it is the step picked; each edge the run took highlighted, the rest faded.
 */
export function runCanvasGraph<N extends { id: string; data?: unknown }, E extends EdgeLike>(graph: GraphLike<N, E>, _run: ReviewedRun, _selected: string | null): { nodes: N[]; edges: E[] } {
    return { nodes: [...graph.nodes], edges: [...graph.edges] };
}
