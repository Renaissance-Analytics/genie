import { useMemo, useState } from 'react';
import { Button, Input, Modal, Select, Text } from '@particle-academy/react-fancy';
import { IconAlert, IconPlus, IconTrash } from './icons';
import {
    api,
    type FlowDraft,
    type FlowEventDefinition,
    type FlowFilter,
    type FlowFilterClause,
    type FlowListPayload,
    type FlowRecipeSummary,
    type FlowSaveResult,
    type FlowScope,
    type FlowSummary,
    type FlowTrigger,
} from '../../lib/genie';
import { coerceFilterValue, flowFormFields } from '../../lib/flow-draft';

/**
 * Authoring a Flow: a body, when it runs, and what it may touch.
 *
 * ## It knows no recipe and no event kind
 *
 * Everything on this form comes from declarations main sends with the list —
 * the recipe's inputs and consequence, the event kinds and their props, the
 * operators each prop type accepts. A second recipe appears in the picker with
 * working fields, and a second event kind in the trigger menu with its own
 * conditions, without a line changing here. That was the constraint on the
 * whole feature (genie#394): a trigger system that needs an engine change to
 * learn a new event ossifies.
 *
 * ## The operators are SENT, not listed here
 *
 * A second copy of "which operators apply to a number" would eventually offer
 * one the store refuses — with the user staring at a menu that had just told
 * them it was allowed. `main/flows/filter.ts` owns that table and ships it.
 *
 * ## Nothing here decides whether a Flow is valid
 *
 * Save asks main and shows what comes back. A renderer-side copy of the rules
 * would be a second validator, and the second one is the one that gets it
 * wrong: a form that let you save something the store refuses is annoying; one
 * that BLOCKED something the store would have accepted is a feature quietly
 * missing.
 *
 * ## A created Flow is off
 *
 * There is no enable switch on this form, and the draft has no field for one.
 * Arming happens in the manager, behind a confirmation that states what the
 * body will do in the recipe's own words. Creating and arming are different
 * decisions and this makes only the first.
 */
export default function FlowEditorModal({
    payload,
    editing,
    onClose,
    onSaved,
}: {
    payload: FlowListPayload;
    /** The Flow being edited, or `null` to create one. */
    editing: FlowSummary | null;
    onClose: () => void;
    onSaved: (result: Extract<FlowSaveResult, { ok: true }>) => void;
}) {
    const recipes = payload.recipes;
    const [title, setTitle] = useState(editing?.title ?? '');
    const [description, setDescription] = useState(editing?.description ?? '');
    const [recipeId, setRecipeId] = useState(
        editing?.recipeId ?? recipes[0]?.id ?? '',
    );
    const [scope, setScope] = useState<FlowScope>(
        editing?.scope ?? initialScope(payload),
    );
    const [triggers, setTriggers] = useState<FlowTrigger[]>(
        editing ? triggersOf(editing) : [{ kind: 'event', event: payload.events[0]?.id ?? '' }],
    );
    const [args, setArgs] = useState<Record<string, string>>(() => initialArgs(editing));
    const [errors, setErrors] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    const recipe = recipes.find((r) => r.id === recipeId) ?? null;
    const fields = useMemo(
        () => flowFormFields(recipe, triggers, payload.events),
        [recipe, triggers, payload.events],
    );

    const setTrigger = (i: number, next: FlowTrigger): void =>
        setTriggers((prev) => prev.map((t, n) => (n === i ? next : t)));

    const save = async (): Promise<void> => {
        setBusy(true);
        setErrors([]);
        try {
            const built = buildArgs(fields, args);
            if (!built.ok) {
                setErrors(built.errors);
                return;
            }
            const draft: FlowDraft = {
                ...(editing ? { id: editing.id } : {}),
                title: title.trim(),
                ...(description.trim() ? { description: description.trim() } : {}),
                scope,
                triggers,
                recipeId,
                ...(Object.keys(built.args).length > 0 ? { args: built.args } : {}),
            };
            const result = await api().flows.save(draft);
            if (!result.ok) {
                setErrors(result.errors);
                return;
            }
            onSaved(result);
            onClose();
        } catch (e) {
            setErrors([e instanceof Error ? e.message : String(e)]);
        } finally {
            setBusy(false);
        }
    };

    return (
        // Labelled so a screen reader — and a test — names the dialog rather
        // than reading whatever text happens to come first inside it.
        <Modal
            open
            onClose={onClose}
            size="lg"
            aria-label={editing ? `Edit ${editing.title}` : 'New Flow'}
        >
            <Modal.Header>{editing ? `Edit “${editing.title}”` : 'New Flow'}</Modal.Header>
            <Modal.Body>
                <div className="floweditor">
                    <label className="floweditor-field">
                        <Text size="sm">Name</Text>
                        <Input
                            className="floweditor-title"
                            aria-label="Flow name"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Keep the repo light"
                            autoFocus
                        />
                    </label>

                    {/* WHAT IT DOES, before when and where: the body is the
                        decision with consequences, and it should be read first. */}
                    <label className="floweditor-field">
                        <Text size="sm">What it does</Text>
                        <Select
                            aria-label="What it does"
                            value={recipeId}
                            onValueChange={setRecipeId}
                            list={recipes.map((r) => ({ value: r.id, label: r.title }))}
                        />
                        {recipe?.consequence && (
                            <div className="floweditor-consequence">
                                <IconAlert size={13} />
                                <span>{recipe.consequence}</span>
                            </div>
                        )}
                        {recipe && !recipe.runsUnattended && (
                            <Text size="xs" color="muted">
                                This body can only be run by hand — Genie will not run it from an
                                event with nobody present.
                            </Text>
                        )}
                    </label>

                    <div className="floweditor-field">
                        <Text size="sm">When it runs</Text>
                        {triggers.length === 0 && (
                            <Text size="xs" color="muted">
                                Nothing would ever start this Flow. Add a trigger.
                            </Text>
                        )}
                        {triggers.map((trigger, i) => (
                            <TriggerRow
                                key={i}
                                trigger={trigger}
                                events={payload.events}
                                operators={payload.operators}
                                onChange={(next) => setTrigger(i, next)}
                                onRemove={() =>
                                    setTriggers((prev) => prev.filter((_, n) => n !== i))
                                }
                            />
                        ))}
                        <div className="floweditor-addrow">
                            <Button
                                size="sm"
                                variant="ghost"
                                className="floweditor-add-event"
                                onClick={() =>
                                    setTriggers((prev) => [
                                        ...prev,
                                        { kind: 'event', event: payload.events[0]?.id ?? '' },
                                    ])
                                }
                                disabled={payload.events.length === 0}
                            >
                                <IconPlus size={12} /> Add a trigger
                            </Button>
                            {!triggers.some((t) => t.kind === 'manual') && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="floweditor-add-manual"
                                    onClick={() =>
                                        setTriggers((prev) => [...prev, { kind: 'manual' }])
                                    }
                                >
                                    <IconPlus size={12} /> Let me run it by hand
                                </Button>
                            )}
                        </div>
                    </div>

                    <ScopeField payload={payload} scope={scope} onChange={setScope} />

                    {fields.length > 0 && (
                        <div className="floweditor-field">
                            <Text size="sm">Settings</Text>
                            {fields.map(({ input, required }) => (
                                <label key={input.key} className="floweditor-subfield">
                                    <Text size="xs">
                                        {input.label}
                                        {required ? ' *' : ''}
                                    </Text>
                                    <Input
                                        className={`floweditor-arg floweditor-arg-${input.key}`}
                                        aria-label={input.label}
                                        value={args[input.key] ?? ''}
                                        onChange={(e) =>
                                            setArgs((prev) => ({
                                                ...prev,
                                                [input.key]: e.target.value,
                                            }))
                                        }
                                        placeholder={
                                            input.default === undefined
                                                ? ''
                                                : String(input.default)
                                        }
                                    />
                                    {input.description && (
                                        <Text size="xs" color="muted">
                                            {input.description}
                                        </Text>
                                    )}
                                </label>
                            ))}
                        </div>
                    )}

                    <label className="floweditor-field">
                        <Text size="sm">Note (optional)</Text>
                        <Input
                            aria-label="Note"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Why this Flow exists"
                        />
                    </label>

                    {/* EVERY reason, not the first: main returns them all so a
                        single edit fixes the Flow rather than four rounds. */}
                    {errors.length > 0 && (
                        <ul className="floweditor-errors">
                            {errors.map((e, i) => (
                                <li key={i}>{e}</li>
                            ))}
                        </ul>
                    )}

                    {!editing && (
                        <Text size="xs" color="muted">
                            New Flows are created switched off. Turn it on in the list when you
                            are ready — Genie will tell you what it does before it arms.
                        </Text>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                    Cancel
                </Button>
                <Button className="floweditor-save" onClick={() => void save()} disabled={busy}>
                    {busy ? 'Saving…' : editing ? 'Save changes' : 'Create Flow'}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

/* ===== triggers ======================================================== */

/** How a clause's group reads in the builder. `describeClause` prints the same. */
const GROUPS: { value: 'all' | 'any' | 'none'; label: string }[] = [
    { value: 'all', label: 'must' },
    { value: 'any', label: 'or' },
    { value: 'none', label: 'must not' },
];

type ClauseRow = { group: 'all' | 'any' | 'none'; clause: FlowFilterClause };

/**
 * The conditions of one trigger, flattened for editing.
 *
 * Read back in GROUP order rather than the order they were added, so changing a
 * clause's group moves it beside the others in that group. That is deliberate:
 * the filter MEANS "all of these, any of these, none of these", and a list that
 * kept insertion order would show three interleaved rows whose reading depends
 * on a word in a select box.
 */
function clauseRows(trigger: FlowTrigger): ClauseRow[] {
    if (trigger.kind !== 'event' || !trigger.filter) return [];
    return GROUPS.flatMap(({ value }) =>
        (trigger.filter?.[value] ?? []).map((clause) => ({ group: value, clause })),
    );
}

function rowsToFilter(rows: ClauseRow[]): FlowFilter | undefined {
    if (rows.length === 0) return undefined;
    const filter: FlowFilter = {};
    for (const { group, clause } of rows) {
        (filter[group] ??= []).push(clause);
    }
    return filter;
}

function TriggerRow({
    trigger,
    events,
    operators,
    onChange,
    onRemove,
}: {
    trigger: FlowTrigger;
    events: FlowEventDefinition[];
    operators: FlowListPayload['operators'];
    onChange: (next: FlowTrigger) => void;
    onRemove: () => void;
}) {
    if (trigger.kind === 'manual') {
        return (
            <div className="floweditor-trigger">
                <Text size="xs">When you run it</Text>
                <button
                    type="button"
                    className="gicon floweditor-remove"
                    onClick={onRemove}
                    aria-label="Remove this trigger"
                >
                    <IconTrash size={12} />
                </button>
            </div>
        );
    }

    const def = events.find((e) => e.id === trigger.event);
    const rows = clauseRows(trigger);
    const setRows = (next: ClauseRow[]): void =>
        onChange({ kind: 'event', event: trigger.event, ...withFilter(rowsToFilter(next)) });

    return (
        <div className="floweditor-trigger">
            <div className="floweditor-trigger-head">
                <Select
                    aria-label="Trigger event"
                    value={trigger.event}
                    onValueChange={(event) =>
                        // The conditions are DROPPED with the event, not carried
                        // over: they name props of the old kind, and a filter on
                        // a prop the new event never emits is refused at the
                        // write. Silently keeping them would make the save fail
                        // with an error about something the user cannot see.
                        onChange({ kind: 'event', event })
                    }
                    list={events.map((e) => ({ value: e.id, label: e.label }))}
                />
                <button
                    type="button"
                    className="gicon floweditor-remove"
                    onClick={onRemove}
                    aria-label="Remove this trigger"
                >
                    <IconTrash size={12} />
                </button>
            </div>

            {rows.map((row, i) => (
                <ClauseEditor
                    key={i}
                    row={row}
                    def={def}
                    operators={operators}
                    onChange={(next) => setRows(rows.map((r, n) => (n === i ? next : r)))}
                    onRemove={() => setRows(rows.filter((_, n) => n !== i))}
                />
            ))}

            {def && def.props.length > 0 && (
                <Button
                    size="sm"
                    variant="ghost"
                    className="floweditor-add-condition"
                    onClick={() =>
                        setRows([
                            ...rows,
                            {
                                group: 'all',
                                clause: {
                                    prop: def.props[0]!.key,
                                    op: firstOpFor(operators, def.props[0]!.type),
                                    value: '',
                                },
                            },
                        ])
                    }
                >
                    <IconPlus size={12} /> Add a condition
                </Button>
            )}
        </div>
    );
}

function ClauseEditor({
    row,
    def,
    operators,
    onChange,
    onRemove,
}: {
    row: ClauseRow;
    def: FlowEventDefinition | undefined;
    operators: FlowListPayload['operators'];
    onChange: (next: ClauseRow) => void;
    onRemove: () => void;
}) {
    const prop = def?.props.find((p) => p.key === row.clause.prop);
    const allowed = operators.filter((o) => prop && o.accepts.includes(prop.type));
    const spec = operators.find((o) => o.op === row.clause.op);
    const raw = Array.isArray(row.clause.value)
        ? row.clause.value.join(', ')
        : String(row.clause.value ?? '');

    const commit = (text: string): void => {
        // A prop the event does not declare cannot be coerced -- but the box
        // must still accept typing. Storing the raw text lets the store say
        // what is wrong; refusing the keystroke would look like a frozen field.
        if (!prop) {
            onChange({ ...row, clause: { ...row.clause, value: text } });
            return;
        }
        const parsed = coerceFilterValue(text, prop.type, spec?.listValue ?? false);
        // An unparseable value stays as TEXT in the clause. The store refuses it
        // and says why, which beats a box that silently refuses to accept what
        // was typed.
        onChange({
            ...row,
            clause: { ...row.clause, value: parsed.ok ? parsed.value : text },
        });
    };

    return (
        <div className="floweditor-clause">
            <Select
                aria-label="Condition group"
                value={row.group}
                onValueChange={(group) =>
                    onChange({ ...row, group: group as ClauseRow['group'] })
                }
                list={GROUPS}
            />
            <Select
                aria-label="Condition prop"
                value={row.clause.prop}
                onValueChange={(propKey) => {
                    const next = def?.props.find((p) => p.key === propKey);
                    // The operator is re-chosen with the prop: `gt` on a string
                    // is refused at the write, and leaving it there would make a
                    // perfectly ordinary edit fail for a reason nowhere on screen.
                    onChange({
                        ...row,
                        clause: {
                            prop: propKey,
                            op: next ? firstOpFor(operators, next.type) : row.clause.op,
                            value: '',
                        },
                    });
                }}
                list={(def?.props ?? []).map((p) => ({ value: p.key, label: p.label }))}
            />
            <Select
                aria-label="Condition operator"
                value={row.clause.op}
                onValueChange={(op) => onChange({ ...row, clause: { ...row.clause, op } })}
                list={allowed.map((o) => ({ value: o.op, label: opLabel(o.op) }))}
            />
            <Input
                className="floweditor-clause-value"
                aria-label="Condition value"
                value={raw}
                onChange={(e) => commit(e.target.value)}
                placeholder={spec?.listValue ? 'png, jpg' : ''}
            />
            <button
                type="button"
                className="gicon floweditor-remove"
                onClick={onRemove}
                aria-label="Remove this condition"
            >
                <IconTrash size={12} />
            </button>
        </div>
    );
}

/* ===== scope =========================================================== */

function ScopeField({
    payload,
    scope,
    onChange,
}: {
    payload: FlowListPayload;
    scope: FlowScope;
    onChange: (next: FlowScope) => void;
}) {
    const kinds = [
        { value: 'system', label: 'Anywhere on this machine' },
        { value: 'workspace', label: 'One workspace' },
        ...(payload.apps.length > 0 ? [{ value: 'gapp', label: 'A Genie App' }] : []),
    ];

    return (
        <div className="floweditor-field">
            <Text size="sm">Where it applies</Text>
            <Select
                aria-label="Where it applies"
                value={scope.kind}
                onValueChange={(kind) => {
                    if (kind === 'workspace') {
                        onChange({
                            kind: 'workspace',
                            workspaceId: payload.workspaces[0]?.id ?? '',
                        });
                    } else if (kind === 'gapp') {
                        onChange({ kind: 'gapp', appId: payload.apps[0]?.id ?? '' });
                    } else {
                        onChange({ kind: 'system' });
                    }
                }}
                list={kinds}
            />
            {scope.kind === 'workspace' && (
                <Select
                    aria-label="Workspace"
                    value={scope.workspaceId}
                    onValueChange={(workspaceId) => onChange({ kind: 'workspace', workspaceId })}
                    list={payload.workspaces.map((w) => ({ value: w.id, label: w.name }))}
                />
            )}
            {scope.kind === 'gapp' && (
                <Select
                    aria-label="Genie App"
                    value={scope.appId}
                    onValueChange={(appId) => onChange({ kind: 'gapp', appId })}
                    list={payload.apps.map((a) => ({ value: a.id, label: a.name }))}
                />
            )}
            <Text size="xs" color="muted">
                {scope.kind === 'workspace'
                    ? 'It only ever sees that workspace’s events, so it cannot act on another project’s files.'
                    : scope.kind === 'gapp'
                      ? 'Owned by that app: Genie keeps it out of menus elsewhere. It still reacts to events from anywhere on this machine.'
                      : 'Every event on this machine reaches it.'}
            </Text>
        </div>
    );
}

/* ===== small pure helpers ============================================== */

/** Read the operator's own word. Falls back to the raw name, never to blank. */
function opLabel(op: string): string {
    const WORDS: Record<string, string> = {
        eq: 'is',
        ne: 'is not',
        gt: 'is over',
        gte: 'is at least',
        lt: 'is under',
        lte: 'is at most',
        matches: 'matches',
        startsWith: 'starts with',
        endsWith: 'ends with',
        contains: 'contains',
        in: 'is one of',
        notIn: 'is not one of',
    };
    return WORDS[op] ?? op;
}

function firstOpFor(
    operators: FlowListPayload['operators'],
    type: 'string' | 'number' | 'boolean',
): string {
    return operators.find((o) => o.accepts.includes(type))?.op ?? 'eq';
}

function withFilter(filter: FlowFilter | undefined): { filter?: FlowFilter } {
    return filter ? { filter } : {};
}

/** A workspace by default when there is one — the narrower scope, not the wider. */
function initialScope(payload: FlowListPayload): FlowScope {
    const first = payload.workspaces[0];
    return first ? { kind: 'workspace', workspaceId: first.id } : { kind: 'system' };
}

/**
 * The triggers of the Flow being edited, back in authoring shape.
 *
 * A summary carries triggers with their labels resolved for display; the draft
 * needs the raw clause groups. Rebuilt rather than round-tripped, because the
 * summary deliberately does not carry everything a Flow has.
 */
function triggersOf(flow: FlowSummary): FlowTrigger[] {
    return flow.triggers.map((t) => {
        if (t.kind === 'manual') return { kind: 'manual' };
        const filter: FlowFilter = {};
        for (const c of t.clauses) {
            (filter[c.group] ??= []).push({
                prop: c.prop,
                op: c.op,
                value: Array.isArray(c.value)
                    ? [...(c.value as readonly (string | number | boolean)[])]
                    : (c.value as string | number | boolean),
            });
        }
        return {
            kind: 'event',
            event: t.event,
            ...(t.clauses.length > 0 ? { filter } : {}),
        };
    });
}

function initialArgs(editing: FlowSummary | null): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(editing?.args ?? {})) out[key] = String(value);
    return out;
}

/** Turn the typed boxes into typed values, reporting every bad one at once. */
function buildArgs(
    fields: { input: { key: string; type: 'string' | 'number' | 'boolean'; label: string; required?: boolean; default?: unknown } }[],
    typed: Record<string, string>,
): { ok: true; args: Record<string, string | number | boolean> } | { ok: false; errors: string[] } {
    const args: Record<string, string | number | boolean> = {};
    const errors: string[] = [];
    for (const { input } of fields) {
        const raw = typed[input.key] ?? '';
        // Blank means "use the body's own default". Sending `""` instead would
        // store an empty setting that overrides it.
        if (raw.trim() === '') continue;
        const parsed = coerceFilterValue(raw, input.type, false);
        if (!parsed.ok) errors.push(`${input.label}: ${parsed.error}`);
        else args[input.key] = parsed.value as string | number | boolean;
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, args };
}
