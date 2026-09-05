/**
 * PURE. What the Flow Manager is handed to draw.
 *
 * The list answers five things per Flow — who owns it, when it fires, whether it
 * is armed, whether it is running, what happened last — and assembling that is a
 * join over the store, the event registry, the run history and live state.
 * The join is the part with bugs in it, so it lives here rather than inside a
 * component where the only way to exercise it is to render one.
 *
 * ## `canEverFire` is the reason the manager is worth opening
 *
 * `store.ts` refuses a Flow whose trigger event nothing emits — but that gate is
 * on the way IN. A Flow saved while an event existed and read back after its
 * producer stopped registering it walks straight past it, and then looks
 * completely normal in a list: a title, a purpose, a green enabled light, and no
 * possibility of ever running again. Same for a Flow scoped to a workspace that
 * has been removed: every event it could match now carries a different
 * workspace id, so `match.eventInScope` fails it closed, silently, forever.
 *
 * Both are said out loud here. An automation surface whose most valuable
 * sentence is "this cannot fire, and here is why" should not make the user
 * deduce it from an id they do not recognise.
 *
 * ## Values are resolved, not formatted
 *
 * A clause comes back with its prop LABEL and its raw value — not "over 5 MB".
 * Byte formatting, date formatting and truncation are the renderer's job, and a
 * main-side module inventing display strings is how two surfaces end up
 * disagreeing about what the same Flow says.
 */

import type { FlowEventRegistry } from './events';
import type { FlowRunRecord } from './activity';
import type { Flow, FlowFilter, FlowFilterClause, FlowPropValue, FlowScope } from './types';

/** Which half of a `FlowFilter` a clause came from — "these, but not those". */
export type FlowClauseGroup = 'all' | 'any' | 'none';

export interface FlowSummaryClause {
    group: FlowClauseGroup;
    prop: string;
    /** The registry's label, or the raw key when the event is unknown. */
    propLabel: string;
    op: FlowFilterClause['op'];
    value: FlowPropValue | readonly FlowPropValue[];
}

export type FlowSummaryTrigger =
    | { kind: 'manual' }
    | {
          kind: 'event';
          event: string;
          /** The registry's label, or the raw id when nothing emits it. */
          eventLabel: string;
          /** False when nothing emits this event — the Flow cannot fire on it. */
          known: boolean;
          clauses: FlowSummaryClause[];
      };

export interface FlowSummary {
    id: string;
    title: string;
    purpose: string;
    description?: string;
    enabled: boolean;
    scope: FlowScope;
    /** Who owns it, in words. Names the thing, or says it is gone. */
    scopeLabel: string;
    triggers: FlowSummaryTrigger[];
    /** A human can press Run: enabled, and it has a manual trigger. */
    manuallyRunnable: boolean;
    /**
     * Anything at all could still start this Flow.
     *
     * False for a disabled Flow, one whose every event trigger is unregistered,
     * and one scoped to a workspace that no longer exists.
     */
    canEverFire: boolean;
    /** A run is in flight right now. */
    running: boolean;
    lastRun?: FlowRunRecord;
    /** The recipe id this Flow's body resolves to. */
    recipeId: string;
    /**
     * The standing values stored for that body's inputs.
     *
     * Carried so EDITING a Flow shows what it was configured with rather than
     * an empty box that silently clears the setting on save.
     */
    args?: Readonly<Record<string, FlowPropValue>>;
    /**
     * What arming this Flow will DO, in its recipe's own words. Absent when the
     * body declares none — which renders as silence, never as a reassurance.
     */
    consequence?: string;
}

export interface SummariseFlowsOptions {
    registry: FlowEventRegistry;
    /** Workspace id → name, for a workspace-scoped Flow's label. */
    workspaceNames?: ReadonlyMap<string, string>;
    /** App id → name, for a gapp-scoped Flow's label. */
    appNames?: ReadonlyMap<string, string>;
    lastRuns?: ReadonlyMap<string, FlowRunRecord>;
    runningFlowIds?: readonly string[];
    /** Recipe id → what running it does, from the recipe's own declaration. */
    recipeConsequences?: ReadonlyMap<string, string>;
}

const GROUPS: readonly FlowClauseGroup[] = ['all', 'any', 'none'];

function clausesOf(
    filter: FlowFilter | undefined,
    propLabel: (key: string) => string,
): FlowSummaryClause[] {
    if (!filter) return [];
    const out: FlowSummaryClause[] = [];
    for (const group of GROUPS) {
        for (const clause of filter[group] ?? []) {
            out.push({
                group,
                prop: clause.prop,
                propLabel: propLabel(clause.prop),
                op: clause.op,
                value: clause.value,
            });
        }
    }
    return out;
}

function summariseTrigger(
    trigger: Flow['triggers'][number],
    registry: FlowEventRegistry,
): FlowSummaryTrigger {
    if (trigger.kind === 'manual') return { kind: 'manual' };

    const def = registry.get(trigger.event);
    const propLabel = (key: string): string =>
        def?.props.find((p) => p.key === key)?.label ?? key;

    return {
        kind: 'event',
        event: trigger.event,
        eventLabel: def?.label ?? trigger.event,
        known: def !== undefined,
        clauses: clausesOf(trigger.filter, propLabel),
    };
}

function scopeLabelOf(scope: FlowScope, opts: SummariseFlowsOptions): string {
    switch (scope.kind) {
        case 'system':
            return 'Whole machine';
        case 'workspace':
            return (
                opts.workspaceNames?.get(scope.workspaceId) ??
                'A workspace that no longer exists'
            );
        case 'gapp':
            return opts.appNames?.get(scope.appId) ?? 'An app that is no longer installed';
    }
}

/** A scope that can still receive events at all. */
function scopeIsLive(scope: FlowScope, opts: SummariseFlowsOptions): boolean {
    if (scope.kind === 'workspace') {
        // `match.eventInScope` compares the event's `workspaceId` prop against
        // this one and fails closed. A removed workspace emits nothing carrying
        // its id, so the Flow is unreachable rather than merely quiet.
        return opts.workspaceNames === undefined || opts.workspaceNames.has(scope.workspaceId);
    }
    if (scope.kind === 'gapp') {
        return opts.appNames === undefined || opts.appNames.has(scope.appId);
    }
    return true;
}

export function summariseFlows(
    flows: readonly Flow[],
    opts: SummariseFlowsOptions,
): FlowSummary[] {
    const running = new Set(opts.runningFlowIds ?? []);

    return [...flows]
        .sort((a, b) => a.purpose.localeCompare(b.purpose) || a.title.localeCompare(b.title))
        .map((flow) => {
            const triggers = flow.triggers.map((t) => summariseTrigger(t, opts.registry));
            // Any ONE live trigger is enough — a Flow is not dead because one of
            // its several triggers names an event that went away.
            const hasLiveTrigger = triggers.some(
                (t) => t.kind === 'manual' || t.known,
            );
            const lastRun = opts.lastRuns?.get(flow.id);
            const consequence = opts.recipeConsequences?.get(flow.recipe.recipeId);

            return {
                id: flow.id,
                title: flow.title,
                purpose: flow.purpose,
                ...(flow.description ? { description: flow.description } : {}),
                enabled: flow.enabled,
                scope: flow.scope,
                scopeLabel: scopeLabelOf(flow.scope, opts),
                triggers,
                manuallyRunnable:
                    flow.enabled && flow.triggers.some((t) => t.kind === 'manual'),
                canEverFire: flow.enabled && hasLiveTrigger && scopeIsLive(flow.scope, opts),
                running: running.has(flow.id),
                ...(lastRun ? { lastRun } : {}),
                recipeId: flow.recipe.recipeId,
                ...(flow.recipe.args ? { args: flow.recipe.args } : {}),
                ...(consequence ? { consequence } : {}),
            };
        });
}
