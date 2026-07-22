import type { api } from '../genie';
import type { FormStepSpec, Recipe, RecipeContext, RecipeField, RecipeStep, StepState } from './types';

/**
 * RecipeEngine — a framework-agnostic runner for a Recipe. It owns the pure
 * mechanics the WizardModal needs: which step is current, each step's lifecycle
 * state, forward-gating (back is always free, forward is gated on the current
 * step being `success`), the shared context store, captured values and per-step
 * error surfacing. It runs NO effects itself — the React step components run the
 * terminal / browser / task effects and report the outcome back via
 * markRunning / markSuccess / markError, so this whole class is testable with no
 * DOM and no Genie IPC.
 */

export interface RecipeEngineOptions {
    workspaceId?: string;
    workstationId?: string;
    initialData?: Record<string, unknown>;
}

/** Immutable snapshot for `useSyncExternalStore`-style consumers. */
export interface EngineSnapshot {
    index: number;
    stepStates: StepState[];
    errors: (string | null)[];
    data: Record<string, unknown>;
    completed: boolean;
}

/** A capture instruction: write `value` under `key` in the context on success. */
export interface CaptureInstruction {
    key: string;
    value: unknown;
}

export class RecipeEngine {
    readonly recipe: Recipe;
    readonly workspaceId?: string;
    readonly workstationId?: string;

    private _index = 0;
    private readonly _data = new Map<string, unknown>();
    private _stepStates: StepState[];
    private _errors: (string | null)[];
    private _completed = false;

    private readonly _listeners = new Set<() => void>();
    private _snapshot: EngineSnapshot | null = null;

    constructor(recipe: Recipe, opts: RecipeEngineOptions = {}) {
        if (!recipe.steps || recipe.steps.length === 0) {
            throw new Error(`Recipe "${recipe.id}" has no steps.`);
        }
        this.recipe = recipe;
        this.workspaceId = opts.workspaceId;
        this.workstationId = opts.workstationId;
        this._stepStates = recipe.steps.map((_, i) => (i === 0 ? 'active' : 'idle'));
        this._errors = recipe.steps.map(() => null);
        for (const [k, v] of Object.entries(opts.initialData ?? {})) {
            this._data.set(k, v);
        }
    }

    /* ----- selectors -------------------------------------------------- */

    get index(): number {
        return this._index;
    }

    get steps(): RecipeStep[] {
        return this.recipe.steps;
    }

    get currentStep(): RecipeStep {
        return this.recipe.steps[this._index];
    }

    get isLastStep(): boolean {
        return this._index === this.recipe.steps.length - 1;
    }

    get isComplete(): boolean {
        return this._completed;
    }

    /** A defensive copy of the per-step lifecycle states. */
    get stepStates(): StepState[] {
        return [...this._stepStates];
    }

    /** A defensive copy of the per-step error messages. */
    get errors(): (string | null)[] {
        return [...this._errors];
    }

    stateOf(step: number | string): StepState {
        return this._stepStates[this.resolveIndex(step)];
    }

    errorOf(step: number | string): string | null {
        return this._errors[this.resolveIndex(step)] ?? null;
    }

    /** Forward is unlocked only when the current step has succeeded. */
    canAdvance(): boolean {
        return this._stepStates[this._index] === 'success';
    }

    /**
     * Whether a jump to `target` is permitted: any backward (or same) target is
     * free; a forward target requires every step from the current one up to
     * `target - 1` to be `success`.
     */
    canGoTo(target: number): boolean {
        if (target < 0 || target >= this.recipe.steps.length) return false;
        if (target <= this._index) return true;
        for (let s = this._index; s < target; s++) {
            if (this._stepStates[s] !== 'success') return false;
        }
        return true;
    }

    /* ----- context ---------------------------------------------------- */

    get(key: string): unknown {
        return this._data.get(key);
    }

    set(key: string, value: unknown): void {
        this._data.set(key, value);
        this.emit();
    }

    /** A live RecipeContext backed by this engine's store + the given api. */
    buildContext(apiFn: typeof api): RecipeContext {
        return {
            get: (k) => this._data.get(k),
            set: (k, v) => this.set(k, v),
            api: apiFn,
            workspaceId: this.workspaceId,
            workstationId: this.workstationId,
        };
    }

    /* ----- step lifecycle transitions --------------------------------- */

    /** Mark a step's effect as in flight; clears any prior error on it. */
    markRunning(step?: number | string): void {
        const i = this.resolveIndex(step);
        this._stepStates[i] = 'running';
        this._errors[i] = null;
        this.emit();
    }

    /**
     * Mark a step satisfied — forward from it becomes possible. An optional
     * capture writes `value` under `key` in the context (e.g. a terminal step
     * storing captured output).
     */
    markSuccess(step?: number | string, capture?: CaptureInstruction): void {
        const i = this.resolveIndex(step);
        this._stepStates[i] = 'success';
        this._errors[i] = null;
        if (capture) this._data.set(capture.key, capture.value);
        this.emit();
    }

    /** Mark a step's effect as failed and surface a message; keeps forward locked. */
    markError(step: number | string | undefined, message: string): void {
        const i = this.resolveIndex(step);
        this._stepStates[i] = 'error';
        this._errors[i] = message;
        this.emit();
    }

    /** Return a step to `active` (re-run) and clear its error. */
    resetStep(step?: number | string): void {
        const i = this.resolveIndex(step);
        this._stepStates[i] = 'active';
        this._errors[i] = null;
        this.emit();
    }

    /* ----- navigation ------------------------------------------------- */

    /** Advance to the next step if the current one is satisfied. */
    next(): boolean {
        if (this.isLastStep || !this.canAdvance()) return false;
        this.enter(this._index + 1);
        return true;
    }

    /** Go to the previous step. Always allowed; never loses prior progress. */
    back(): boolean {
        if (this._index === 0) return false;
        this._index -= 1;
        this.emit();
        return true;
    }

    /** Jump to `target` subject to `canGoTo` gating. */
    goTo(target: number): boolean {
        if (!this.canGoTo(target)) return false;
        this.enter(target);
        return true;
    }

    /** Finish the recipe — only from the last step, once it is satisfied. */
    complete(): boolean {
        if (!this.isLastStep || !this.canAdvance()) return false;
        this._completed = true;
        this.emit();
        return true;
    }

    /* ----- subscription (useSyncExternalStore) ------------------------ */

    subscribe(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    getSnapshot(): EngineSnapshot {
        if (!this._snapshot) {
            this._snapshot = {
                index: this._index,
                stepStates: [...this._stepStates],
                errors: [...this._errors],
                data: Object.fromEntries(this._data),
                completed: this._completed,
            };
        }
        return this._snapshot;
    }

    /* ----- internals -------------------------------------------------- */

    private enter(target: number): void {
        this._index = target;
        if (this._stepStates[target] === 'idle') {
            this._stepStates[target] = 'active';
        }
        this.emit();
    }

    private resolveIndex(step?: number | string): number {
        if (step === undefined) return this._index;
        if (typeof step === 'number') return step;
        const i = this.recipe.steps.findIndex((s) => s.id === step);
        if (i < 0) throw new Error(`Unknown recipe step: ${step}`);
        return i;
    }

    private emit(): void {
        this._snapshot = null; // invalidate — next getSnapshot rebuilds
        for (const l of this._listeners) l();
    }
}

/**
 * Resolve a form step's fields against the current context. A step may declare a
 * static `fields` list OR a function of the context (so it can adapt to earlier
 * answers — e.g. showing a flags control only for the enabled agents). Pure, so
 * both the FormStep view and the recipe tests resolve fields the same way.
 */
export function resolveFields(step: FormStepSpec, ctx: RecipeContext): RecipeField[] {
    return typeof step.fields === 'function' ? step.fields(ctx) : step.fields;
}

/* ===== pure helpers shared with the TerminalStep component ============= */

/**
 * Decide a terminal step's outcome from an `until` spec and the terminal's
 * observed state. A `pattern` match on the accumulated output is the primary
 * "done" signal and wins even before exit. Otherwise, once the process has
 * exited: an explicit `until.exit` must match; a required (but unmatched)
 * pattern means failure; and with neither constraint, exit 0 succeeds.
 */
export function evaluateTerminalUntil(
    until: { pattern?: string; exit?: number } | undefined,
    outcome: { exitCode?: number | null; output?: string },
): 'success' | 'fail' | 'pending' {
    const { pattern, exit } = until ?? {};
    const output = outcome.output ?? '';
    if (pattern && new RegExp(pattern).test(output)) return 'success';

    const exited = outcome.exitCode !== undefined && outcome.exitCode !== null;
    if (!exited) return 'pending';

    if (exit !== undefined) return outcome.exitCode === exit ? 'success' : 'fail';
    if (pattern) return 'fail'; // exited without ever matching the required pattern
    return outcome.exitCode === 0 ? 'success' : 'fail';
}

/**
 * Extract the value a terminal step captures. When the `until.pattern` has a
 * capturing group and matches, the first group is returned; otherwise the full
 * output, trimmed.
 */
export function captureTerminalOutput(
    until: { pattern?: string } | undefined,
    output: string,
): string {
    const pattern = until?.pattern;
    if (pattern) {
        const m = new RegExp(pattern).exec(output);
        if (m && m.length > 1 && m[1] !== undefined) return m[1];
    }
    return output.trim();
}
