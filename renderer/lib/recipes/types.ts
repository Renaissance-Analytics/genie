import type { api } from '../genie';

/**
 * The Recipe API — a "very simple API" for setup-style workflows the
 * WizardModal renders. A recipe author writes DATA (an ordered list of
 * declarative steps), not React. The RecipeEngine owns transitions, gating,
 * capture and error surfacing; the WizardModal owns rendering (Fancy
 * Carousel), the embedded-terminal lifecycle and the browser hand-off.
 *
 * The shapes of `Recipe`, `RecipeStep` and `RecipeContext` are LOCKED by the
 * design brief (.ai/_discovery/genie-wizardmodal-recipe-framework.md) and must
 * not drift. `RecipeField` / `RecipeOption` are the two shapes the brief names
 * but does not define — see their doc comments for the decisions made here.
 */

/** A single labelled input inside a `form` step. Writes into the context. */
export interface RecipeField {
    /** Context key this field's value is stored under (ctx.get(key)). */
    key: string;
    label: string;
    /**
     * Control kind. `select` uses `options`; everything else renders a
     * Fancy `Input` with the matching HTML input type. Defaults to `text`.
     */
    type?: 'text' | 'password' | 'number' | 'select';
    placeholder?: string;
    description?: string;
    /** When true the step is not forward-satisfied until this field is set. */
    required?: boolean;
    /** Options for `type: 'select'`. */
    options?: RecipeOption[];
    /** Seed value written into the context when the step first activates. */
    defaultValue?: string;
}

/** A selectable option in a `choice` step or a `select` field. */
export interface RecipeOption {
    value: string;
    label: string;
    description?: string;
}

/**
 * Shared, mutable state threaded through every step, plus the Genie bridge and
 * optional scope. `api` is the SAME `api()` accessor the rest of the renderer
 * uses, so tasks and checks can reach IPC / the remote host bridge. LOCKED.
 */
export interface RecipeContext {
    get(key: string): unknown;
    set(key: string, v: unknown): void;
    /** Genie IPC / remote bridge accessor (renderer/lib/genie `api`). */
    api: typeof api;
    /** Workspace this recipe runs against, when scoped. */
    workspaceId?: string;
    /** Headless host / workstation the terminal steps run on, when remote. */
    workstationId?: string;
}

/**
 * Collect input with Fancy controls; each field writes into the context under
 * its `key`. Forward-satisfied once every `required` field has a value.
 */
export interface FormStepSpec {
    type: 'form';
    id: string;
    title: string;
    fields: RecipeField[];
}

/**
 * Pick one (or, with `multi`, several) option(s); the selection writes into the
 * context under `id`. Forward-satisfied once a selection exists.
 */
export interface ChoiceStepSpec {
    type: 'choice';
    id: string;
    title: string;
    options: RecipeOption[];
    multi?: boolean;
}

/**
 * Embed a ONE-OFF terminal running `command`/`args`. Advances when the process
 * exits 0 (default) or `until` is satisfied — an `exit` code and/or an output
 * `pattern` (a RegExp source string tested against accumulated output). When
 * `capture` is set, the trimmed output (or the first capture group of a matched
 * `pattern`) is written into the context under that key. REMOTE-capable: the
 * terminal may run on the headless host bound by `ctx.workstationId`.
 */
export interface TerminalStepSpec {
    type: 'terminal';
    id: string;
    title: string;
    command: string;
    args?: string[];
    cwd?: string;
    until?: { pattern?: string; exit?: number };
    /** Context key to store captured output under. */
    capture?: string;
}

/**
 * Open a URL in the user's default browser (via the browser-open capability),
 * then optionally poll `check` every `pollMs` until it resolves true. With no
 * `check` the step is forward-satisfied as soon as the URL has been opened.
 */
export interface BrowserStepSpec {
    type: 'browser';
    id: string;
    title: string;
    url: string | ((ctx: RecipeContext) => string);
    check?: (ctx: RecipeContext) => Promise<boolean>;
    pollMs?: number;
}

/** Run an arbitrary async task (call api(), mutate state); advance on resolve. */
export interface TaskStepSpec {
    type: 'task';
    id: string;
    title: string;
    run: (ctx: RecipeContext) => Promise<void>;
}

export type RecipeStep =
    | FormStepSpec
    | ChoiceStepSpec
    | TerminalStepSpec
    | BrowserStepSpec
    | TaskStepSpec;

/** An id + title + an ordered list of steps, with an optional completion hook. */
export interface Recipe {
    id: string;
    title: string;
    steps: RecipeStep[];
    onComplete?: (ctx: RecipeContext) => Promise<void> | void;
}

/**
 * Lifecycle state of a single step, tracked by the RecipeEngine.
 *  - `idle`    — not yet reached.
 *  - `active`  — current step, effect not yet satisfied.
 *  - `running` — effect in flight (terminal live, browser polling, task awaited).
 *  - `success` — effect satisfied; forward is unlocked from this step.
 *  - `error`   — effect failed; a message is surfaced and forward stays locked.
 */
export type StepState = 'idle' | 'active' | 'running' | 'success' | 'error';
