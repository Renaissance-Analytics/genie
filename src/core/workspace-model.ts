/**
 * WORKSPACES AND AGENTS (§6.1, §6.2) — the pure half of what was still missing.
 *
 * - Folder CLASSIFICATION and the add-workspace PLAN, shown before anything is written. A folder
 *   that is neither a repo nor an envelope has no plan; it is refused with the reason rather than
 *   guessed into one.
 * - SCHEMA STAMPING with a backup, and a refusal to overwrite a newer revision — a Genie that
 *   downgrades a manifest it does not understand destroys information it cannot see.
 * - HIBERNATE: an ordered shutdown that is also a STATE — asleep comes before stopping, so nothing
 *   may start while the rest is torn down, and it stays asleep through restarts and upgrades.
 * - DIAGNOSE: read-only; names a CAUSE and the repair that fits. `starting` and `dormant` are not
 *   faults, and a running agent gets no invented problem.
 */

export interface FolderFacts {
    readonly exists: boolean;
    /** Top-level entry names. */
    readonly entries: readonly string[];
}

export type FolderKind = 'missing' | 'empty' | 'simple-repo' | 'pre-init' | 'full-envelope' | 'other';

export function classifyFolder(facts: FolderFacts): FolderKind {
    if (!facts.exists) return 'missing';
    const has = (name: string) => facts.entries.includes(name);
    if (facts.entries.length === 0) return 'empty';
    if (has('project.json') && has('repos') && has('.ai')) return 'full-envelope';
    if (has('.agi') || (has('repos') && !has('project.json'))) return 'pre-init';
    if (has('.git')) return 'simple-repo';
    return 'other';
}

export interface PlanStep {
    readonly action: string;
    readonly path: string;
    readonly writes: boolean;
}

const SCRATCH: readonly string[] = ['create sandbox/ (gitignored)', 'create .trash/ (gitignored)'];

export function planAdd(kind: FolderKind, path: string): PlanStep[] {
    const step = (action: string, writes = true): PlanStep => ({ action, path, writes });
    switch (kind) {
        case 'missing':
            throw new Error(`${path} does not exist; pick a folder that does`);
        case 'other':
            throw new Error(`${path} is neither a repo nor an envelope; Genie will not guess what it is`);
        case 'empty':
            return [step('write project.json'), step('create repos/'), step('create .ai/'), ...SCRATCH.map((a) => step(a)), step('git init'), step('register in Genie', false)];
        case 'simple-repo':
            return [step('write project.json (host repo: this folder)'), step('create .ai/'), ...SCRATCH.map((a) => step(a)), step('register in Genie', false)];
        case 'pre-init':
            return [step('write project.json'), step('create .ai/'), ...SCRATCH.map((a) => step(a)), step('register in Genie', false)];
        case 'full-envelope':
            return [step('register in Genie', false)];
    }
}

/** Civicognita/shared-schemas publishes the envelope schema by git tag; this Genie writes this revision. */
export const SCHEMA_REVISION = '0.2.0';
const SCHEMA_BASE = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v';
const SCHEMA_TAIL = '/schemas/workspace/project.schema.json';

function revisionOf(manifest: Record<string, unknown>): string | null {
    const s = manifest.$schema;
    if (typeof s !== 'string' || !s.startsWith(SCHEMA_BASE)) return null;
    const m = /^v?(\d+\.\d+\.\d+)\/schemas\/workspace\/project\.schema\.json$/.exec(s.slice(SCHEMA_BASE.length));
    return m ? m[1]! : null;
}

function compare(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

export type StampResult =
    | { ok: true; manifest: Record<string, unknown>; backup: string | null; from: string | null }
    | { ok: false; reason: string };

export function stampSchema(manifest: Record<string, unknown>, revision: string): StampResult {
    const from = revisionOf(manifest);
    if (from !== null) {
        const c = compare(from, revision);
        if (c > 0) return { ok: false, reason: `project.json declares schema ${from}, newer than the ${revision} this Genie writes; not touching it` };
        if (c === 0) return { ok: true, manifest, backup: null, from };
    }
    return {
        ok: true,
        manifest: { ...manifest, $schema: `${SCHEMA_BASE}${revision}${SCHEMA_TAIL}` },
        backup: `project.json.pre-schema-${revision}.bak`,
        from,
    };
}

export type HibernateStep =
    | { kind: 'ask-handoff'; agents: readonly string[]; waitMs: number }
    | { kind: 'mark-asleep' }
    | { kind: 'stop-agents'; agents: readonly string[] }
    | { kind: 'stop-terminals'; terminals: readonly string[] }
    | { kind: 'stop-processes'; processes: readonly string[] }
    | { kind: 'leave-inbox'; agents: readonly string[] };

export interface HibernatePlan {
    readonly steps: HibernateStep[];
    readonly staysAsleepThrough: readonly ['restart', 'upgrade'];
}

export function hibernate(input: { workspaceId: string; agents: readonly string[]; terminals: readonly string[]; processes: readonly string[]; handoffWaitMs: number }): HibernatePlan {
    const steps: HibernateStep[] = [];
    if (input.agents.length > 0) steps.push({ kind: 'ask-handoff', agents: input.agents, waitMs: input.handoffWaitMs });
    steps.push({ kind: 'mark-asleep' });
    if (input.agents.length > 0) steps.push({ kind: 'stop-agents', agents: input.agents });
    if (input.terminals.length > 0) steps.push({ kind: 'stop-terminals', terminals: input.terminals });
    if (input.processes.length > 0) steps.push({ kind: 'stop-processes', processes: input.processes });
    if (input.agents.length > 0) steps.push({ kind: 'leave-inbox', agents: input.agents });
    return { steps, staysAsleepThrough: ['restart', 'upgrade'] };
}

export interface DiagnoseInput {
    readonly threadId: string | null;
    readonly lastUsedAt: string | null;
    readonly session: { state: 'starting'; sinceMs: number } | { state: 'running' } | { state: 'crashed'; exitCode: number | null } | null;
    readonly providerInstalled: boolean;
    readonly signedIn: boolean;
    readonly provider?: string;
}

export type Repair =
    | { action: 'install-provider' }
    | { action: 'sign-in' }
    | { action: 'restart-graceful' }
    | { action: 'restart-fresh'; reason: string };

export interface Diagnosis {
    readonly state: 'dormant' | 'starting' | 'healthy' | 'broken';
    readonly fault: boolean;
    readonly cause: string | null;
    readonly repair: Repair | null;
}

const RESUMABLE = /^[A-Za-z0-9._:-]{1,200}$/;

export function diagnoseAgent(input: DiagnoseInput): Diagnosis {
    const provider = input.provider ?? 'claude';
    if (!input.providerInstalled) return { state: 'broken', fault: true, cause: `${provider} is not installed`, repair: { action: 'install-provider' } };
    if (!input.signedIn) return { state: 'broken', fault: true, cause: `${provider} is not signed in`, repair: { action: 'sign-in' } };
    const s = input.session;
    if (s === null) {
        if (input.threadId === null && input.lastUsedAt === null) return { state: 'dormant', fault: false, cause: 'registered, never started', repair: null };
        return { state: 'healthy', fault: false, cause: null, repair: null };
    }
    if (s.state === 'starting') return { state: 'starting', fault: false, cause: `started ${Math.round(s.sinceMs / 1000)} s ago, no turn yet`, repair: null };
    if (s.state === 'running') return { state: 'healthy', fault: false, cause: null, repair: null };
    const cause = s.exitCode === null ? 'the provider process exited without a code' : `the provider process exited with code ${s.exitCode}`;
    const repair: Repair =
        input.threadId !== null && !RESUMABLE.test(input.threadId)
            ? { action: 'restart-fresh', reason: `the stored thread id is not one Genie can hand back to ${provider}; a graceful restart would refuse` }
            : { action: 'restart-graceful' };
    return { state: 'broken', fault: true, cause, repair };
}
