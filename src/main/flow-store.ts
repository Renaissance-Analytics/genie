import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseCron, timeZoneProblem } from '../core/cron.js';
import { canonicalFlowDocument, flowNodes } from '../core/flow-form.js';
import type { V1SchedulePlan } from '../core/v1-schedules.js';
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

export type RunOutcome = 'ran' | 'failed' | 'held';

/** One run of a flow, as it ended. */
export interface FlowRun {
    /** When it started (ISO). */
    readonly at: string;
    /** When it ended (ISO). A held-back run ends where it starts. */
    readonly endedAt: string;
    /** `schedule` = its timer fired; `manual` = the person's Run now. */
    readonly trigger: 'schedule' | 'manual';
    readonly outcome: RunOutcome;
    /** Why it failed or was held back, in words. Absent for a run that ran. */
    readonly reason?: string;
}

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
    /** Set on a flow brought over from Genie 1 (core/v1-schedules.ts): which scheduled task it was. */
    readonly importedFrom?: { readonly v1SpecId: string };
}

/** What the Genie 1 import did, kept IN flows.json — the store it filled — so "once" and the flows cannot disagree. */
export interface V1ScheduleImportRecord {
    readonly at: string;
    /** false = the boot could not see v1's database: provisional, a later boot that can see it still imports. */
    readonly sawV1: boolean;
    readonly imported?: number;
    /** v1 tasks whose flow was already here — left exactly as they were. */
    readonly alreadyHere?: number;
    readonly notes?: readonly string[];
}

interface FlowsFile {
    flows: FlowRecord[];
    v1Import?: V1ScheduleImportRecord;
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
        const store = new FlowStore(file, { flows, ...(v1Import ? { v1Import } : {}) }, now);
        // A document that moved into the canonical shape is written back now, so the file never holds two shapes.
        if (flows.some((f, i) => f.document !== raw[i]!.document)) await store.#flush();
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

    /** Record one run as it ended; the history keeps the last `RUN_HISTORY_LIMIT`. Returns the run, or null for a flow removed meanwhile. */
    async recordRun(id: string, run: { trigger: FlowRun['trigger']; outcome: RunOutcome; reason?: string; startedAt: number }): Promise<FlowRun | null> {
        const flow = this.get(id);
        if (!flow) return null;
        const entry: FlowRun = {
            at: new Date(run.startedAt).toISOString(),
            endedAt: this.#iso(),
            trigger: run.trigger,
            outcome: run.outcome,
            ...(run.outcome !== 'ran' && run.reason !== undefined ? { reason: run.reason } : {}),
        };
        await this.#replace({ ...flow, runs: [...flow.runs, entry].slice(-RUN_HISTORY_LIMIT) });
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

    /** What the Genie 1 import did, or undefined when it has not been attempted. */
    v1Import(): V1ScheduleImportRecord | undefined {
        return this.#data.v1Import;
    }

    /**
     * GENIE 1's SCHEDULED TASKS, ONCE (core/v1-schedules.ts plans them). Every flow comes over DISARMED: the
     * person arms what they still want. "Once" is recorded in this file in the same write as the flows, so an
     * import that saw v1 is never repeated — a flow the person removed or changed stays as they left it. A
     * plan of `null` (v1 not visible) is recorded provisionally and a later boot that can see v1 imports. A
     * flow whose id is already here is left alone and counted.
     */
    async importFromV1(plan: V1SchedulePlan | null): Promise<{ alreadyDone: boolean; record: V1ScheduleImportRecord }> {
        const prior = this.#data.v1Import;
        if (prior?.sawV1 === true) return { alreadyDone: true, record: prior };
        const at = this.#iso();
        if (plan === null) {
            if (prior) return { alreadyDone: true, record: prior };
            const record: V1ScheduleImportRecord = { at, sawV1: false };
            this.#data = { ...this.#data, v1Import: record };
            await this.#flush();
            return { alreadyDone: false, record };
        }
        const have = new Set(this.#data.flows.map((f) => f.id));
        const fresh: FlowRecord[] = [];
        const notes = [...plan.notes];
        for (const p of plan.flows) {
            if (have.has(p.id)) continue;
            // A task the engine refuses is NOTED and left behind. It does not stop the others — nor, by failing the
            // whole import, make every later boot retry it and fail again.
            let document: Record<string, unknown>;
            try {
                document = validated(p.document);
            } catch (error) {
                notes.push(`"${p.name}" (v1 task ${p.v1SpecId}): ${error instanceof Error ? error.message : String(error)}; not imported`);
                continue;
            }
            fresh.push({
                id: p.id,
                workspaceId: p.workspaceId,
                name: p.name,
                document,
                armed: false,
                createdBy: { kind: 'user' },
                createdAt: at,
                updatedAt: at,
                refusals: [],
                runs: [],
                importedFrom: { v1SpecId: p.v1SpecId },
            });
        }
        const record: V1ScheduleImportRecord = { at, sawV1: true, imported: fresh.length, alreadyHere: plan.flows.filter((p) => have.has(p.id)).length, notes };
        this.#data = { ...this.#data, flows: [...this.#data.flows, ...fresh], v1Import: record };
        await this.#flush();
        return { alreadyDone: false, record };
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
