import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { importWorkflow } from '@particle-academy/fancy-flow/schema';
import { parseCron } from '../core/cron.js';
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
 * Documents are fancy-flow `WorkflowSchema` JSON, validated by the engine's own `importWorkflow`
 * — a document without `version: 1` is refused by every runtime, so it is refused here too.
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

export interface LastRun {
    readonly at: string;
    readonly ok: boolean;
    readonly error?: string;
}

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
    readonly lastRun?: LastRun;
}

interface FlowsFile {
    flows: FlowRecord[];
}

export type ArmResult = { ok: true; flow: FlowRecord } | { ok: false; reason: string };

function actorName(by: Actor): string {
    return by.kind === 'agent' ? by.name : 'user';
}

export class FlowStore {
    readonly #file: string;
    readonly #now: () => number;
    #data: FlowsFile;
    readonly #listeners = new Set<() => void>();

    private constructor(file: string, data: FlowsFile, now: () => number) {
        this.#file = file;
        this.#data = data;
        this.#now = now;
    }

    static async open(userData: string, now: () => number = Date.now): Promise<FlowStore> {
        const file = join(runtimeDir(userData), 'flows.json');
        return new FlowStore(file, await readJson<FlowsFile>(file, { flows: [] }), now);
    }

    /** Fires after every change the scheduler should re-plan on. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async create(input: { workspaceId: string; name: string; document: unknown; by: Actor; armed?: boolean }): Promise<FlowRecord> {
        const document = validated(input.document);
        const at = this.#iso();
        const refusals: Refusal[] = [];
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
            refusals: [...refusals, ...scheduleRefusals(document, input.by, at)],
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

    async recordRun(id: string, run: { ok: boolean; error?: string }): Promise<void> {
        const flow = this.get(id);
        if (!flow) return;
        await this.#replace({ ...flow, lastRun: { at: this.#iso(), ok: run.ok, ...(run.error === undefined ? {} : { error: run.error }) } });
    }

    async remove(id: string): Promise<boolean> {
        const before = this.#data.flows.length;
        this.#data.flows = this.#data.flows.filter((f) => f.id !== id);
        if (this.#data.flows.length === before) return false;
        await this.#flush();
        return true;
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

/** The engine's own validation. Errors are refused with the engine's words. */
function validated(document: unknown): Record<string, unknown> {
    const result = importWorkflow(document);
    if (!result.ok) {
        const errors = result.issues.filter((i) => i.level === 'error').map((i) => i.message);
        throw new Error(`the flow document was refused by the engine: ${errors.join('; ') || 'not a usable workflow (check version: 1)'}`);
    }
    return document as Record<string, unknown>;
}

function schedulesIn(document: Record<string, unknown>): Schedule[] {
    const nodes = Array.isArray(document.nodes) ? (document.nodes as Array<Record<string, unknown>>) : [];
    return nodes
        .filter((n) => typeof n.kind === 'string' && /(^|\/)schedule_trigger$/.test(n.kind))
        .map((n) => {
            const config = (n.config ?? {}) as Record<string, unknown>;
            return {
                nodeId: String(n.id),
                cron: typeof config.cron === 'string' ? config.cron : '',
                timezone: typeof config.timezone === 'string' ? config.timezone : undefined,
            };
        });
}

/** A schedule the evaluator cannot honour is a refusal on the canvas, not a silent never-fires. */
function scheduleRefusals(document: Record<string, unknown>, by: Actor, at: string): Refusal[] {
    return schedulesIn(document).flatMap((s) => {
        if (parseCron(s.cron) === null) {
            return [{ at, by: actorName(by), action: 'schedule' as const, reason: `node ${s.nodeId}: "${s.cron}" is not a cron expression Genie can evaluate (five fields: minute hour day month weekday)` }];
        }
        if (s.timezone !== undefined && s.timezone !== 'UTC' && s.timezone !== 'Etc/UTC') {
            return [{ at, by: actorName(by), action: 'schedule' as const, reason: `node ${s.nodeId}: timezone ${s.timezone} is not supported yet; schedules are evaluated in UTC` }];
        }
        return [];
    });
}
