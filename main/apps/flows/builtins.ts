/**
 * What Genie does with fancy-flow's OWN node kinds.
 *
 * The engine ships node *definitions* — config schema, ports, label, editor UI —
 * and almost no executors. Across every subpath the only ones exported are
 * `llmBranchExecutor`, `llmRouterExecutor`, `subflowExecutor`, `durableUserInput`
 * and `durableApproval`. `branch`, `transform`, `merge`, `wait`, `switch_case`,
 * `variable`, `log` and `output` have none.
 *
 * That is the security design, not an omission: a graph is inert data, and
 * `api_request` (arbitrary outbound HTTP) is dangerous only if a host chooses to
 * implement it. So every kind below is a DECISION, and the three answers are:
 *
 *   - **implement** — pure, local, and a flow without it is a script;
 *   - **pause** — it stops for a person, which Genie has a surface for;
 *   - **refuse** — with a reason, out loud.
 *
 * ## A refusal is a first-class answer, and it is not silence
 *
 * A node Genie will not run must ABORT the flow, never return undefined and let
 * the graph continue. A step that quietly does nothing turns "Genie does not do
 * this" into "the automation half-ran and reported success", which is the worst
 * outcome available: nobody looks at a green run.
 *
 * Every refusal here names the kind and says what to use instead where there is
 * something to use, because the person reading it is looking at a canvas and can
 * fix it in one drag.
 *
 * ## Unresolvable expressions
 *
 * `evaluateExpression` resolves `{{ dot.path }}` against the run's data and — by
 * default — yields empty string for a path that does not resolve. For a LOG
 * message that is right. For a ROUTING DECISION it is not: a branch that reads a
 * misspelled path would take the `false` edge every time, forever, on a run that
 * reports success. The engine's own notes record a consumer shipping a document
 * containing the literal text of its own template for exactly this reason.
 *
 * So comparisons resolve with `onUnresolved: 'throw'`, and the run stops where
 * the mistake is. The absence operators (`empty`, `not_empty`, `falsy`) are the
 * deliberate exception: "is this missing" is the question they ask, so an
 * unresolved path is their ANSWER rather than their failure.
 */

import {
    UnresolvedPathError,
    evaluateExpression,
    pauseForHuman,
    truthy,
} from '@particle-academy/fancy-flow/engine';

/** The ctx `runFlow` hands an executor, narrowed to what Genie reads. */
export interface BuiltinCtx {
    node: {
        id?: unknown;
        type?: unknown;
        data?: { kind?: unknown; label?: unknown; config?: unknown } | null;
    };
    inputs: Record<string, unknown>;
    abort: (reason?: string) => never;
    emit: (event: unknown) => void;
}

export type BuiltinExecutor = (
    ctx: BuiltinCtx,
    scope: FlowRunScope,
) => Promise<unknown> | unknown;

/**
 * Values a `variable` node has set, for the life of ONE run.
 *
 * A Map built per run rather than a module global — two flows running at once
 * must not read each other's variables, and a value surviving into the next run
 * would make a flow's behaviour depend on what ran before it.
 */
export type FlowRunScope = Map<string, unknown>;

/* ===== reading a node ==================================================== */

function config(ctx: BuiltinCtx): Record<string, unknown> {
    const raw = ctx.node.data?.config;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

/**
 * The data an expression may read.
 *
 * `inputs` already carries whatever arrived on each port, plus `$props` when the
 * graph declares inputs, plus each upstream node's value under its own id — so
 * `{{ n2.text }}`, the spelling authors and assistants reach for first, resolves.
 * `$vars` is Genie's addition and the only thing this adds.
 */
function context(ctx: BuiltinCtx, scope: FlowRunScope): Record<string, unknown> {
    return { ...ctx.inputs, $vars: Object.fromEntries(scope) };
}

/**
 * The one input a node with a single meaningful input carries.
 *
 * The builtin kit's convention is a `value` port; a lone input is taken when
 * there is exactly one, and the whole map otherwise — guessing among several
 * would be worse than handing them all on.
 */
function soleInput(inputs: Record<string, unknown>): unknown {
    if (inputs && typeof inputs === 'object' && 'value' in inputs) return inputs.value;
    const values = Object.values(inputs ?? {});
    return values.length === 1 ? values[0] : inputs;
}

/* ===== branch ============================================================ */

/** Operators whose question IS whether the value is there. */
const ABSENCE_OPERATORS = new Set(['empty', 'not_empty', 'falsy']);

/** Resolve one side of a comparison, loudly unless absence is the question. */
function operand(
    template: unknown,
    ctx: BuiltinCtx,
    scope: FlowRunScope,
    operator: string,
): unknown {
    if (typeof template !== 'string') return template;
    const absence = ABSENCE_OPERATORS.has(operator);
    try {
        return evaluateExpression(template, context(ctx, scope), {
            onUnresolved: absence ? 'empty' : 'throw',
        });
    } catch (e) {
        if (absence && e instanceof UnresolvedPathError) return null;
        throw e;
    }
}

function isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
}

/** A number for an ordering comparison, or null when the pair is not orderable. */
function orderable(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function compare(left: unknown, operator: string, right: unknown, label: string): boolean {
    switch (operator) {
        case 'eq':
            // Loose by value-as-text, because one side of a comparison routinely
            // arrives as a string from a template and the other as a number from
            // JSON. `5 === "5"` being false is a correct answer to a question
            // nobody asked.
            return String(left) === String(right);
        case 'neq':
            return String(left) !== String(right);
        case 'contains':
            return Array.isArray(left)
                ? left.some((v) => String(v) === String(right))
                : String(left).includes(String(right));
        case 'not_contains':
            return !compare(left, 'contains', right, label);
        case 'truthy':
            return truthy(left);
        case 'falsy':
            return !truthy(left);
        case 'empty':
            return isEmpty(left);
        case 'not_empty':
            return !isEmpty(left);
        default:
            break;
    }

    const a = orderable(left);
    const b = orderable(right);
    if (a === null || b === null) {
        // NOT false. `"abc" > 5` has no answer, and answering "no" would route
        // the flow down a branch on a comparison that never happened.
        throw new Error(
            `${label}: cannot compare ${JSON.stringify(left)} and ${JSON.stringify(right)} ` +
                `with "${operator}" — one of them is not a number.`,
        );
    }
    switch (operator) {
        case 'gt':
            return a > b;
        case 'gte':
            return a >= b;
        case 'lt':
            return a < b;
        case 'lte':
            return a <= b;
        default:
            throw new Error(`${label}: unknown condition operator "${operator}".`);
    }
}

const branch: BuiltinExecutor = (ctx, scope) => {
    const cfg = config(ctx);
    const label = `Step “${str(ctx.node.data?.label, String(ctx.node.id ?? 'branch'))}”`;
    const value = soleInput(ctx.inputs);

    // The raw expression is the documented escape hatch and OVERRIDES the
    // builder rows when set — the field says so, so honouring the rows instead
    // would silently ignore what the author typed last.
    const raw = str(cfg.condition).trim();
    if (raw !== '') {
        const result = evaluateExpression(raw, context(ctx, scope), { onUnresolved: 'throw' });
        return { branch: truthy(result) ? 'true' : 'false', value };
    }

    const rows = Array.isArray(cfg.conditions) ? cfg.conditions : [];
    if (rows.length === 0) {
        return ctx.abort(
            `${label} has no conditions, so there is nothing for it to decide. ` +
                `Add a condition, or delete the step.`,
        );
    }

    const any = str(cfg.match, 'all') === 'any';
    let matched = !any; // all → start true; any → start false.

    for (const row of rows) {
        const r = (row ?? {}) as Record<string, unknown>;
        const operator = str(r.operator, 'eq');
        const hit = compare(
            operand(r.left, ctx, scope, operator),
            operator,
            operand(r.right, ctx, scope, operator),
            label,
        );
        if (any && hit) {
            matched = true;
            break;
        }
        if (!any && !hit) {
            matched = false;
            break;
        }
    }

    return { branch: matched ? 'true' : 'false', value };
};

/* ===== the rest of the implemented kit =================================== */

const switchCase: BuiltinExecutor = (ctx, scope) => {
    const cfg = config(ctx);
    const label = `Step “${str(ctx.node.data?.label, String(ctx.node.id ?? 'switch'))}”`;
    const raw = str(cfg.value).trim();
    if (raw === '') {
        return ctx.abort(`${label} has nothing to switch on.`);
    }

    const value = evaluateExpression(raw, context(ctx, scope), { onUnresolved: 'throw' });
    const cases = cfg.cases && typeof cfg.cases === 'object' ? (cfg.cases as Record<string, unknown>) : {};
    const port = cases[String(value)];

    // `default` is a real port the kind declares, so an unmatched value is
    // routed rather than dropped. A switch that silently ended the branch would
    // be indistinguishable from one whose case list is wrong.
    return { branch: typeof port === 'string' && port !== '' ? port : 'default', value };
};

const merge: BuiltinExecutor = (ctx) => {
    const a = ctx.inputs.a;
    const b = ctx.inputs.b;

    if (str(config(ctx).mode, 'merge') === 'concat') {
        const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
        return [...list(a), ...list(b)];
    }

    const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    // `b` last: the canvas draws `a` above `b`, and later-wins is the reading
    // every merge in the language shares.
    return { ...obj(a), ...obj(b) };
};

const transform: BuiltinExecutor = (ctx, scope) => {
    const cfg = config(ctx);
    const data = context(ctx, scope);

    if (str(cfg.mode, 'fields') === 'expression') {
        const raw = str(cfg.expression).trim();
        if (raw === '') return soleInput(ctx.inputs);
        return evaluateExpression(raw, data, { onUnresolved: 'throw' });
    }

    const rows = Array.isArray(cfg.fields) ? cfg.fields : [];
    const out: Record<string, unknown> = {};
    for (const row of rows) {
        const r = (row ?? {}) as Record<string, unknown>;
        const key = str(r.key).trim();
        // A row with no key is a half-finished edit, not an instruction. Naming
        // a field "" would put a key nothing can read into the output.
        if (key === '') continue;
        out[key] = evaluateExpression(str(r.value), data, { onUnresolved: 'throw' });
    }
    return out;
};

const variable: BuiltinExecutor = (ctx, scope) => {
    const cfg = config(ctx);
    const name = str(cfg.name).trim();
    if (name === '') {
        return ctx.abort('A Variable step needs a name, or nothing can read what it stores.');
    }
    const value = evaluateExpression(str(cfg.value), context(ctx, scope), {
        onUnresolved: 'throw',
    });
    scope.set(name, value);
    return value;
};

/**
 * How long a `wait` may hold a run.
 *
 * Ten minutes. A flow is a background automation, not a scheduler: "run this
 * tomorrow" is a second trigger, not a step that sleeps for a day holding a
 * timeout, a claim row and a slot in the run list. The cap is stated to the
 * author rather than silently applied.
 */
const MAX_WAIT_MS = 10 * 60 * 1000;

const wait: BuiltinExecutor = async (ctx) => {
    const cfg = config(ctx);
    const mode = str(cfg.mode, 'duration');
    if (mode !== 'duration') {
        return ctx.abort(
            `Genie can only wait for a DURATION, not for “${mode}”. ` +
                `To run something later, give the flow a Schedule trigger instead.`,
        );
    }

    const ms = parseDuration(str(cfg.duration));
    if (ms === null) {
        return ctx.abort(
            `“${str(cfg.duration)}” is not a duration Genie understands. ` +
                `Use a number of milliseconds, or a value like 30s, 5m or 2h.`,
        );
    }
    if (ms > MAX_WAIT_MS) {
        return ctx.abort(
            `A flow cannot wait longer than 10 minutes in one step. ` +
                `Use a Schedule trigger to run something later.`,
        );
    }

    await new Promise((resolve) => setTimeout(resolve, ms));
    return soleInput(ctx.inputs);
};

/** `1500`, `30s`, `5m`, `2h` → milliseconds. Null when it is none of those. */
export function parseDuration(raw: string): number | null {
    const text = raw.trim().toLowerCase();
    if (text === '') return null;
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text);
    if (!match) return null;
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = match[2] ?? 'ms';
    const scale = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
    return n * scale;
}

const log: BuiltinExecutor = (ctx, scope) => {
    const cfg = config(ctx);
    const level = str(cfg.level, 'info');
    // 'empty' here, deliberately: a log line is not a decision, and losing the
    // whole run because a message template referenced something absent would be
    // the observability tool taking the system down.
    const message = evaluateExpression(str(cfg.message), context(ctx, scope), {
        onUnresolved: 'empty',
    });

    ctx.emit({
        type: 'log',
        nodeId: ctx.node.id,
        level: level === 'warn' || level === 'error' ? level : 'info',
        message: typeof message === 'string' ? message : JSON.stringify(message),
    });
    return soleInput(ctx.inputs);
};

/** The value the flow arrived at. */
const output: BuiltinExecutor = (ctx) => soleInput(ctx.inputs);

/**
 * A trigger's job is to exist and hand the run its starting payload.
 *
 * Whether the flow should run AT ALL was decided before `runFlow` was called —
 * by the scheduler, by the event bus, or by a person pressing Run — and which
 * trigger fired is expressed through `entryNodes`, not here.
 */
const trigger: BuiltinExecutor = (ctx) => {
    const cfg = config(ctx);
    // The run's props are seeded onto entry points by the engine, so they are in
    // `inputs`. Handing both on means a downstream step can read either the
    // trigger's own settings or what the event carried.
    return { ...cfg, ...ctx.inputs };
};

/* ===== the ones that stop for a person =================================== */

/**
 * Park the run and ask.
 *
 * `pauseForHuman` aborts with a structured token (`fancy-flow:pause:{…}`) rather
 * than throwing an ordinary error, so the runner can tell "this is waiting for
 * you" from "this broke" — and can resume it later by replaying every node that
 * already ran through `resumeOutputs`, which republishes them instead of running
 * them a second time.
 */
const humanPause =
    (awaiting: 'approval' | 'input'): BuiltinExecutor =>
    (ctx) =>
        pauseForHuman(ctx as never, awaiting, {
            title: str(config(ctx).title, awaiting === 'approval' ? 'Approve this step' : 'Genie needs your input'),
            description: str(config(ctx).description),
            fields: config(ctx).fields,
            value: soleInput(ctx.inputs),
        });

/* ===== the ones Genie refuses ============================================ */

/**
 * Why each refused kind is refused, in the author's own terms.
 *
 * Data rather than a switch, so adding a kind means adding a sentence — and a
 * kind with no sentence falls through to the generic refusal rather than being
 * admitted by omission.
 */
const REFUSALS: Readonly<Record<string, string>> = {
    api_request:
        'it makes arbitrary web requests, and a flow that can call any URL is not bounded by what this app was allowed to do. Use a Genie step for the thing you actually want to reach.',
    webhook_out: 'it posts to arbitrary URLs. See “API Request” — the same reason.',
    tool_use: 'Genie does not host tool-calling models. Run an agent step instead.',
    embed_search: 'Genie has no embedding store wired to flows. Use the Knowledge step.',
    llm_call:
        'Genie does not call models directly from a flow — the spend and the attribution would belong to nobody. Use an agent step, which runs under an agent that has both.',
    llm_router: 'it routes by calling a model. See “LLM Call” — the same reason.',
    notify:
        'its channels are somebody else’s (Slack, email). Use the “Tell the user” step, which reaches this user where they already are.',
    memory_store: 'Genie has not decided where a flow’s data lives or who may read it, so it will not store any yet.',
    data_store: 'Genie has not decided where a flow’s data lives or who may read it, so it will not store any yet.',
    subflow:
        'running another flow needs an answer to whose permissions the inner flow acts under, and Genie does not have one yet.',
    for_each:
        'Genie runs a graph once through, so it cannot yet repeat the steps after this one per item. Fan out with a Run Agent step, or handle the list in one step.',
    webhook_trigger:
        'Genie has nowhere for an inbound request to land yet, so this flow will only run when started by hand or by another trigger.',
};

/* ===== the table ========================================================= */

/**
 * Every fancy-flow builtin, and what Genie does with it.
 *
 * Keyed by the CANONICAL kind id. Aliases are resolved by the caller against the
 * live registry, so a graph written with `branch` and one written with
 * `@particle-academy/branch` reach the same entry — and a kind renamed upstream
 * does not silently become unhandled.
 */
const IMPLEMENTED: Readonly<Record<string, BuiltinExecutor>> = {
    '@particle-academy/manual_trigger': trigger,
    '@particle-academy/schedule_trigger': trigger,
    '@particle-academy/branch': branch,
    '@particle-academy/switch_case': switchCase,
    '@particle-academy/merge': merge,
    '@particle-academy/transform': transform,
    '@particle-academy/variable': variable,
    '@particle-academy/wait': wait,
    '@particle-academy/log': log,
    '@particle-academy/output': output,
    '@particle-academy/human_approval': humanPause('approval'),
    '@particle-academy/user_input': humanPause('input'),
    '@particle-academy/rich_user_input': humanPause('input'),
};

/** The executor for a fancy builtin, or null when it is not one Genie runs. */
export function builtinExecutor(canonicalKind: string): BuiltinExecutor | null {
    return IMPLEMENTED[canonicalKind] ?? null;
}

/** Why Genie refuses this kind, or null when it has no stated reason. */
export function refusalFor(canonicalKind: string): string | null {
    const bare = canonicalKind.replace(/^@[^/]+\//, '');
    return REFUSALS[bare] ?? null;
}

/** Every builtin Genie implements — for the palette, and for its own tests. */
export function implementedBuiltins(): string[] {
    return Object.keys(IMPLEMENTED);
}
