import type { FileAddedProps } from '../core/file-trigger.js';
import type { NodeOutcome } from '../core/flow-canvas.js';
import type { V1FlowPlan } from '../core/v1-flows.js';
import { stepLabel } from '../core/flow-reach.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseCron, timeZoneProblem } from '../core/cron.js';
import { canonicalFlowDocument, flowNodes } from '../core/flow-form.js';
import { importFlowDocument } from './flow-kinds.js';
import { runtimeDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * FLOWS (§6.6) — the store. Scheduled and repeating work on fancy-flow.
 *
 * **An agent can CREATE a flow but never ARM one.** Arming is the moment a schedule starts
 * firing work on the user's machine without anyone watching; that is a person's decision. An
 * agent's `armed: true` is ignored at create, and an agent's `arm` is refused — and the refusal is
 * NAMED ON THE CANVAS (`refusals`, with who, what and why), so the flow shows what was attempted
 * rather than silently staying off. Disarming is open to both: it only ever makes less happen.
 *
 * Documents are fancy-flow `WorkflowSchema` JSON — `{ $schema, version: 1, graph: { nodes, edges } }` — validated by
 * the engine's own `importWorkflow` with Genie's step kinds registered (flow-kinds.ts). A document without
 * `version: 1`, with a kind nobody registered, or with a step missing the config it needs is REFUSED with the
 * engine's words (every engine issue refuses — flow-kinds.ts says why its warnings do too). A document in the old
 * top-level shape (`nodes`/`edges` beside `version`) is migrated to the canonical one on the way in, and a
 * flows.json written by an earlier beta is migrated when it is opened (and written back, so the file holds one shape).
 *
 * ## What each run did (hosting ship line P4)
 *
 * Every run — scheduled or the person's Run now — is recorded on its flow: when, which, and the
 * OUTCOME: `ran`, `failed` with the reason, or `held` back with why (the target agent was busy, the
 * workspace hibernated, the previous run still going). The history is bounded (`RUN_HISTORY_LIMIT`,
 * newest last) so a flow that fires every minute cannot grow the file without end.
 */

export type Actor = { readonly kind: 'agent'; readonly id: string; readonly name: string } | { readonly kind: 'user' };

export interface Refusal {
    readonly at: string;
    /** The agent's name, or `user`. */
    readonly by: string;
    readonly action: 'arm' | 'schedule';
    readonly reason: string;
}

export interface Schedule {
    readonly nodeId: string;
    readonly cron: string;
    readonly timezone: string | undefined;
}

/** A file run: the `genie/file_added` node that fired, and the file that landed (core/file-trigger.ts). */
export interface FileFired {
    readonly nodeId: string;
    readonly file: FileAddedProps;
}

/** `stopped` = Genie quit while it ran (genie#1204): recorded at the next launch, at the step it was on — never lost. */
export type RunOutcome = 'ran' | 'failed' | 'held' | 'stopped';

/** One step of a run that stopped (genie#1204): which node, in words, and how far it got. */
export interface FlowRunStep {
    readonly nodeId: string;
    readonly label: string;
    readonly outcome: 'ran' | 'failed' | 'held' | 'not reached';
}

/** One run of a flow, as it ended. */
export interface FlowRun {
    /** When it started (ISO). */
    readonly at: string;
    /** When it ended (ISO). A held-back run ends where it starts. */
    readonly endedAt: string;
    /** `schedule` = its timer fired; `manual` = the person's Run now. */
    readonly trigger: 'schedule' | 'manual' | 'file';
    /** A `file` run: the file that started it, relative to its workspace (genie#1204). */
    readonly file?: string;
    readonly outcome: RunOutcome;
    /** Why it failed or was held back, in words. Absent for a run that ran. */
    readonly reason?: string;
    /** A run that STOPPED (failed or held): its steps in graph order, and where it stopped (genie#1204). */
    readonly steps?: readonly FlowRunStep[];
    /** Every node's outcome, for EVERY run — what the canvas draws over the flow's graph (genie#1204 item 6). */
    readonly nodes?: Readonly<Record<string, NodeOutcome>>;
    /** The Log nodes' lines, in order (bounded). */
    readonly log?: readonly string[];
}

/** A run in flight, kept on disk as it goes (genie#1204 (e)): if Genie quits under it, the next launch records it `stopped`. */
export interface FlowInFlight {
    readonly at: string;
    readonly trigger: FlowRun['trigger'];
    readonly file?: string;
    readonly nodes: Readonly<Record<string, NodeOutcome>>;
}

/** How many Log lines a run keeps. */
export const RUN_LOG_LIMIT = 50;

/** How many runs each flow keeps; the oldest goes first. */
export const RUN_HISTORY_LIMIT = 20;

export interface FlowRecord {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly document: Record<string, unknown>;
    readonly armed: boolean;
    readonly createdBy: Actor;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly refusals: readonly Refusal[];
    /** The last `RUN_HISTORY_LIMIT` runs, oldest first. */
    readonly runs: readonly FlowRun[];
    /** The run going now, if any (genie#1204 (e)). */
    readonly inFlight?: FlowInFlight;
    /** Set on a flow an earlier beta brought over from Genie 1's scheduled tasks; moved to the processes (scheduled-tasks-move.ts). */
    readonly importedFrom?: { readonly v1SpecId: string };
}

/**
 * What an earlier beta's import of Genie 1's scheduled tasks did, kept in flows.json. Read and kept as it is: those tasks
 * are background processes now (process-book.ts imports them; scheduled-tasks-move.ts moved the ones imported here).
 */
export interface V1ScheduleImportRecord {
    readonly at: string;
    /** false = the boot could not see v1's database: provisional, a later boot that can see it still imports. */
    readonly sawV1: boolean;
    readonly imported?: number;
    /** v1 tasks whose flow was already here — left exactly as they were. */
    readonly alreadyHere?: number;
    readonly notes?: readonly string[];
}

/** What the import of Genie 1's FLOWS did (genie#1204, main/v1-flows.ts), kept in flows.json — the store it filled. */
export interface V1FlowImportRecord {
    readonly at: string;
    /** false = the boot could not see Genie 1's flows table: provisional, a later boot that can see it imports. */
    readonly sawV1: boolean;
    readonly imported?: number;
    readonly alreadyHere?: number;
    /** Each flow not imported, with why (core/v1-flows.ts), and each the engine refused, in its words. */
    readonly notes: readonly string[];
}

interface FlowsFile {
    flows: FlowRecord[];
    v1Import?: V1ScheduleImportRecord;
    v1FlowImport?: V1FlowImportRecord;
}

export type ArmResult = { ok: true; flow: FlowRecord } | { ok: false; reason: string };

function actorName(by: Actor): string {
    return by.kind === 'agent' ? by.name : 'user';
}

/**
 * A record as read from disk: `runs` always a list (an older file had a single `lastRun`, which is not carried — it
 * never recorded an executed step), and its document in the canonical shape. The document is NOT re-validated here:
 * a flow an earlier beta accepted stays the person's, and the runner refuses to run it, in the engine's words, if
 * the engine refuses it.
 */
function normalised(raw: FlowRecord & { lastRun?: unknown }): FlowRecord {
    const rest: FlowRecord & { lastRun?: unknown } = { ...raw, document: canonicalFlowDocument(raw.document) as Record<string, unknown>, runs: Array.isArray(raw.runs) ? raw.runs : [] };
    delete rest.lastRun;
    return rest;
}

export class FlowStore {
    readonly #file: string;
    readonly #now: () => number;
    #data: FlowsFile;
    readonly #listeners = new Set<() => void>();
    readonly #runListeners = new Set<(flowId: string, run: FlowRun) => void>();

    private constructor(file: string, data: FlowsFile, now: () => number) {
        this.#file = file;
        this.#data = data;
        this.#now = now;
    }

    static async open(userData: string, now: () => number = Date.now): Promise<FlowStore> {
        const file = join(runtimeDir(userData), 'flows.json');
        const data = await readJson<FlowsFile>(file, { flows: [] });
        const raw = Array.isArray(data.flows) ? data.flows : [];
        const flows = raw.map((f) => normalised(f));
        const v1Import = data.v1Import !== null && typeof data.v1Import === 'object' ? data.v1Import : undefined;
        // A run Genie quit in the middle of (genie#1204 (e)) is recorded STOPPED, at the step it was on — never silently lost.
        const settled = flows.map((f) => (f.inFlight ? stoppedByQuit(f, new Date(now()).toISOString()) : f));
        const v1FlowImport = data.v1FlowImport !== null && typeof data.v1FlowImport === 'object' ? data.v1FlowImport : undefined;
        const store = new FlowStore(file, { flows: settled, ...(v1Import ? { v1Import } : {}), ...(v1FlowImport ? { v1FlowImport } : {}) }, now);
        // A document that moved into the canonical shape is written back now, so the file never holds two shapes.
        if (flows.some((f, i) => f.document !== raw[i]!.document) || settled.some((f, i) => f !== flows[i])) await store.#flush();
        return store;
    }

    /** Fires with each run as it ends (`recordRun`): its flow and the run — a sound for it (Tynn #766 C2b). */
    onRun(listener: (flowId: string, run: FlowRun) => void): () => void {
        this.#runListeners.add(listener);
        return () => this.#runListeners.delete(listener);
    }

    /** Fires after every change the scheduler should re-plan on. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async create(input: { workspaceId: string; name: string; document: unknown; by: Actor; armed?: boolean }): Promise<FlowRecord> {
        const document = validated(input.document);
        const at = this.#iso();
        // An agent's `armed: true` is not an error — it is simply not theirs to set.
        const armed = input.by.kind === 'user' && input.armed === true;
        const flow: FlowRecord = {
            id: `flow_${randomUUID()}`,
            workspaceId: input.workspaceId,
            name: input.name,
            document,
            armed,
            createdBy: input.by,
            createdAt: at,
            updatedAt: at,
            refusals: scheduleRefusals(document, input.by, at),
            runs: [],
        };
        this.#data.flows.push(flow);
        await this.#flush();
        return flow;
    }

    get(id: string): FlowRecord | null {
        return this.#data.flows.find((f) => f.id === id) ?? null;
    }

    list(workspaceId?: string): FlowRecord[] {
        return this.#data.flows.filter((f) => workspaceId === undefined || f.workspaceId === workspaceId);
    }

    /** The schedule triggers in a flow's document, as written. */
    /** The flow's `genie/file_added` triggers (genie#1204): each node's id and its config, as the document holds it. */
    fileTriggers(id: string): { nodeId: string; config: Record<string, unknown> }[] {
        const flow = this.get(id);
        if (!flow) return [];
        return flowNodes(flow.document)
            .filter((n) => n.kind === 'genie/file_added')
            .map((n) => ({ nodeId: String(n.id), config: { ...((n.config ?? {}) as Record<string, unknown>) } }));
    }

    schedules(id: string): Schedule[] {
        const flow = this.get(id);
        return flow ? schedulesIn(flow.document) : [];
    }

    async update(id: string, patch: { name?: string; document?: unknown }, by: Actor): Promise<FlowRecord> {
        const flow = this.#require(id);
        const document = patch.document === undefined ? flow.document : validated(patch.document);
        const at = this.#iso();
        const next: FlowRecord = {
            ...flow,
            name: patch.name ?? flow.name,
            document,
            updatedAt: at,
            refusals: [...flow.refusals, ...(patch.document === undefined ? [] : scheduleRefusals(document, by, at))],
        };
        await this.#replace(next);
        return next;
    }

    async arm(id: string, by: Actor): Promise<ArmResult> {
        const flow = this.#require(id);
        if (by.kind === 'agent') {
            const reason = `an agent can create a flow but never arm one; ask the user to arm "${flow.name}"`;
            await this.#replace({ ...flow, refusals: [...flow.refusals, { at: this.#iso(), by: by.name, action: 'arm', reason }] });
            return { ok: false, reason };
        }
        const next = { ...flow, armed: true, updatedAt: this.#iso() };
        await this.#replace(next);
        return { ok: true, flow: next };
    }

    async disarm(id: string, _by: Actor): Promise<FlowRecord> {
        const next = { ...this.#require(id), armed: false, updatedAt: this.#iso() };
        await this.#replace(next);
        return next;
    }

    /** Keep the run going now on disk, as it goes (genie#1204 (e)); `null` = none. A flow removed meanwhile is left alone. */
    async markInFlight(id: string, inFlight: FlowInFlight | null): Promise<void> {
        const flow = this.get(id);
        if (!flow) return;
        const { inFlight: _was, ...rest } = flow;
        await this.#replace(inFlight === null ? rest : { ...rest, inFlight });
    }

    /** Record one run as it ended; the history keeps the last `RUN_HISTORY_LIMIT`. Returns the run, or null for a flow removed meanwhile. */
    async recordRun(id: string, run: { trigger: FlowRun['trigger']; outcome: RunOutcome; reason?: string; startedAt: number; file?: string; steps?: readonly FlowRunStep[]; nodes?: Readonly<Record<string, NodeOutcome>>; log?: readonly string[] }): Promise<FlowRun | null> {
        const flow = this.get(id);
        if (!flow) return null;
        const entry: FlowRun = {
            at: new Date(run.startedAt).toISOString(),
            endedAt: this.#iso(),
            trigger: run.trigger,
            outcome: run.outcome,
            ...(run.file !== undefined ? { file: run.file } : {}),
            ...(run.outcome !== 'ran' && run.steps !== undefined ? { steps: run.steps } : {}),
            ...(run.outcome !== 'ran' && run.reason !== undefined ? { reason: run.reason } : {}),
            ...(run.nodes !== undefined && Object.keys(run.nodes).length > 0 ? { nodes: run.nodes } : {}),
            ...(run.log !== undefined && run.log.length > 0 ? { log: run.log.slice(-RUN_LOG_LIMIT) } : {}),
        };
        // The run has ended, so it is no longer in flight — in the same write.
        const { inFlight: _done, ...rest } = flow;
        await this.#replace({ ...rest, runs: [...flow.runs, entry].slice(-RUN_HISTORY_LIMIT) });
        for (const l of this.#runListeners) l(id, entry);
        return entry;
    }

    async remove(id: string): Promise<boolean> {
        const before = this.#data.flows.length;
        this.#data.flows = this.#data.flows.filter((f) => f.id !== id);
        if (this.#data.flows.length === before) return false;
        await this.#flush();
        return true;
    }

    /** What the import of Genie 1's flows did, or undefined when it has not been attempted. */
    v1FlowImport(): V1FlowImportRecord | undefined {
        return this.#data.v1FlowImport;
    }

    /**
     * GENIE 1's FLOWS, ONCE (genie#1204; core/v1-flows.ts plans them). Each comes over DISARMED, as the person's, through
     * the same door every flow passes (the engine, Genie's kinds, a loop): one the door refuses is NOTED in the engine's
     * words and left behind, and the others still come over. "Once" is recorded in the same write; `null` (Genie 1's
     * flows not visible) is recorded provisionally, and a later boot that can see them imports. An id already here is
     * left exactly as it is.
     */
    async importV1Flows(plan: V1FlowPlan | null): Promise<V1FlowImportRecord> {
        const prior = this.#data.v1FlowImport;
        if (prior?.sawV1 === true) return prior;
        const at = this.#iso();
        if (plan === null) {
            if (prior) return prior;
            const record: V1FlowImportRecord = { at, sawV1: false, notes: [] };
            this.#data = { ...this.#data, v1FlowImport: record };
            await this.#flush();
            return record;
        }
        const have = new Set(this.#data.flows.map((f) => f.id));
        const notes = [...plan.notes];
        const fresh: FlowRecord[] = [];
        let alreadyHere = 0;
        for (const p of plan.flows) {
            if (have.has(p.id)) { alreadyHere += 1; continue; }
            let document: Record<string, unknown>;
            try {
                document = validated(p.document);
            } catch (error) {
                notes.push(`"${p.name}" (Genie 1 flow ${p.v1Id}): ${error instanceof Error ? error.message : String(error)}; not imported`);
                continue;
            }
            fresh.push({ id: p.id, workspaceId: p.workspaceId, name: p.name, document, armed: false, createdBy: { kind: 'user' }, createdAt: at, updatedAt: at, refusals: [], runs: [] });
        }
        const record: V1FlowImportRecord = { at, sawV1: true, imported: fresh.length, alreadyHere, notes };
        this.#data = { ...this.#data, flows: [...this.#data.flows, ...fresh], v1FlowImport: record };
        await this.#flush();
        return record;
    }

    #require(id: string): FlowRecord {
        const flow = this.get(id);
        if (!flow) throw new Error(`no flow ${id}`);
        return flow;
    }

    #iso(): string {
        return new Date(this.#now()).toISOString();
    }

    async #replace(next: FlowRecord): Promise<void> {
        this.#data.flows = this.#data.flows.map((f) => (f.id === next.id ? next : f));
        await this.#flush();
    }

    async #flush(): Promise<void> {
        await writeJsonAtomic(this.#file, this.#data);
        for (const l of this.#listeners) l();
    }
}

/** A flow whose run was in flight when Genie quit: that run recorded `stopped`, at the step it was on (genie#1204 (e)). */
function stoppedByQuit(flow: FlowRecord, at: string): FlowRecord {
    const going = flow.inFlight!;
    const nodes: Record<string, NodeOutcome> = Object.fromEntries(Object.entries(going.nodes).map(([id, o]) => [id, o === 'running' ? 'stopped' : o]));
    const docNodes = flowNodes(flow.document);
    const at_ = Object.keys(nodes).find((id) => nodes[id] === 'stopped');
    const where = at_ !== undefined ? docNodes.find((n) => String(n.id) === at_) : undefined;
    const run: FlowRun = {
        at: going.at,
        endedAt: at,
        trigger: going.trigger,
        outcome: 'stopped',
        ...(going.file !== undefined ? { file: going.file } : {}),
        reason: `Genie quit while this run was going; it stopped at ${where ? stepLabel(where) : 'its start'}. It was not resumed: run it again if it should finish`,
        nodes,
    };
    const { inFlight: _gone, ...rest } = flow;
    return { ...rest, runs: [...flow.runs, run].slice(-RUN_HISTORY_LIMIT) };
}

/**
 * The engine's own validation (flow-kinds.ts): the document in the canonical shape, or refused with the engine's
 * words — every issue it raised, each naming its node or edge.
 */
function validated(document: unknown): Record<string, unknown> {
    const result = importFlowDocument(document);
    if (!result.ok) throw new Error(`the flow document was refused by the engine: ${result.problems.join('; ')}`);
    return result.document as unknown as Record<string, unknown>;
}

export function schedulesIn(document: Record<string, unknown>): Schedule[] {
    return flowNodes(document)
        .filter((n) => typeof n.kind === 'string' && /(^|\/)schedule_trigger$/.test(n.kind))
        .map((n) => {
            const config = (n.config ?? {}) as Record<string, unknown>;
            return {
                nodeId: String(n.id),
                cron: typeof config.cron === 'string' ? config.cron : '',
                timezone: typeof config.timezone === 'string' && config.timezone.trim() !== '' ? config.timezone : undefined,
            };
        });
}

/** A schedule the evaluator cannot honour is a refusal on the canvas, not a silent never-fires. */
function scheduleRefusals(document: Record<string, unknown>, by: Actor, at: string): Refusal[] {
    return schedulesIn(document).flatMap((s) => {
        if (parseCron(s.cron) === null) {
            return [{ at, by: actorName(by), action: 'schedule' as const, reason: `node ${s.nodeId}: "${s.cron}" is not a cron expression Genie can evaluate (five fields: minute hour day month weekday)` }];
        }
        const zone = timeZoneProblem(s.timezone);
        if (zone !== null) return [{ at, by: actorName(by), action: 'schedule' as const, reason: `node ${s.nodeId}: ${zone}` }];
        return [];
    });
}
