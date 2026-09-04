/**
 * PURE. Whether an event's props satisfy a Wish's predicate.
 *
 * Props are the filter surface — design note 2 of the discovery brief. The
 * owner's reference case is the whole requirement in one line:
 *
 *   > a file added anywhere in a workspace, and if it is over 5 MB it gets moved
 *   > into an untracked folder so the repo does not get heavy
 *
 * An event (file added), a prop (size), a filter (> 5 MB), an action (move).
 * This file is the third of those, and it is generic over props by construction:
 * a clause names a prop by KEY and an operator by name, so nothing here knows or
 * could know which event it is judging.
 *
 * ## Two different kinds of "no"
 *
 * A predicate can be wrong in two ways and they must not be confused:
 *
 *  - **The author wrote nonsense** — a prop the event never emits, `gt` against
 *    a string, a regex that does not compile. That is caught by
 *    {@link validateWishFilter} when the Wish is SAVED, against the event's
 *    declared props. Silently never matching would be the worst outcome: the
 *    Wish looks armed and can never fire.
 *  - **This particular event just does not match** — the file was 2 MB.
 *    {@link matchesWishFilter} returns false and nothing is wrong.
 *
 * A runtime error that escapes both (an invalid regex in a row that predates
 * validation, say) is thrown as a {@link WishFilterError} rather than swallowed
 * into a false. The runtime records it as a refusal with a reason, because a
 * Wish that stopped working deserves to say so.
 */

import type {
    WishEventDefinition,
    WishFilter,
    WishFilterClause,
    WishFilterOp,
    WishPropValue,
} from './types';

/** A filter that could not be evaluated — an authoring fault, not a non-match. */
export class WishFilterError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WishFilterError';
    }
}

/** Operators and what they need, as data — the one place an op is described. */
interface OpSpec {
    /** Prop types this operator can be applied to. */
    accepts: ReadonlySet<'string' | 'number' | 'boolean'>;
    /** True when the clause's `value` must be an array. */
    listValue: boolean;
}

const OPS: Readonly<Record<WishFilterOp, OpSpec>> = {
    eq: { accepts: new Set(['string', 'number', 'boolean']), listValue: false },
    ne: { accepts: new Set(['string', 'number', 'boolean']), listValue: false },
    gt: { accepts: new Set(['number']), listValue: false },
    gte: { accepts: new Set(['number']), listValue: false },
    lt: { accepts: new Set(['number']), listValue: false },
    lte: { accepts: new Set(['number']), listValue: false },
    matches: { accepts: new Set(['string']), listValue: false },
    startsWith: { accepts: new Set(['string']), listValue: false },
    endsWith: { accepts: new Set(['string']), listValue: false },
    contains: { accepts: new Set(['string']), listValue: false },
    in: { accepts: new Set(['string', 'number', 'boolean']), listValue: true },
    notIn: { accepts: new Set(['string', 'number', 'boolean']), listValue: true },
};

export function isWishFilterOp(op: unknown): op is WishFilterOp {
    return typeof op === 'string' && Object.prototype.hasOwnProperty.call(OPS, op);
}

function compileRegex(source: string, clause: WishFilterClause): RegExp {
    try {
        return new RegExp(source);
    } catch (e) {
        throw new WishFilterError(
            `"${clause.prop} matches ${source}" is not a valid regular expression: ` +
                `${e instanceof Error ? e.message : String(e)}`,
        );
    }
}

/**
 * Evaluate one clause.
 *
 * A prop the event did not carry is a NON-MATCH, never a throw: events of the
 * same kind may legitimately omit an optional prop, and a Wish should simply not
 * fire for those. What is NOT tolerated is an operator applied to the wrong type
 * — that is an authoring fault {@link validateWishFilter} exists to catch, and
 * letting it read as "did not match" is how a broken Wish stays broken quietly.
 */
function evaluateClause(
    clause: WishFilterClause,
    props: Readonly<Record<string, WishPropValue>>,
): boolean {
    if (!isWishFilterOp(clause.op)) {
        throw new WishFilterError(`Unknown filter operator "${String(clause.op)}".`);
    }
    if (!Object.prototype.hasOwnProperty.call(props, clause.prop)) return false;

    const actual = props[clause.prop];
    const expected = clause.value;

    switch (clause.op) {
        case 'eq':
            return actual === expected;
        case 'ne':
            return actual !== expected;
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
            if (typeof actual !== 'number') return false;
            if (typeof expected !== 'number') {
                throw new WishFilterError(
                    `"${clause.prop} ${clause.op} …" needs a number to compare against.`,
                );
            }
            if (clause.op === 'gt') return actual > expected;
            if (clause.op === 'gte') return actual >= expected;
            if (clause.op === 'lt') return actual < expected;
            return actual <= expected;
        }
        case 'matches':
        case 'startsWith':
        case 'endsWith':
        case 'contains': {
            if (typeof actual !== 'string') return false;
            if (typeof expected !== 'string') {
                throw new WishFilterError(
                    `"${clause.prop} ${clause.op} …" needs a string to compare against.`,
                );
            }
            if (clause.op === 'matches') return compileRegex(expected, clause).test(actual);
            if (clause.op === 'startsWith') return actual.startsWith(expected);
            if (clause.op === 'endsWith') return actual.endsWith(expected);
            return actual.includes(expected);
        }
        case 'in':
        case 'notIn': {
            if (!Array.isArray(expected)) {
                throw new WishFilterError(`"${clause.prop} ${clause.op} …" needs a list of values.`);
            }
            const present = (expected as readonly WishPropValue[]).includes(actual);
            return clause.op === 'in' ? present : !present;
        }
    }
}

/**
 * Whether `props` satisfy `filter`.
 *
 * Every group PRESENT must hold, so `{ all, none }` reads as "these, but not
 * those". An absent or empty filter matches everything — a trigger with no
 * predicate is a legitimate "whenever this happens", not an error.
 */
export function matchesWishFilter(
    filter: WishFilter | undefined,
    props: Readonly<Record<string, WishPropValue>>,
): boolean {
    if (!filter) return true;

    const all = filter.all ?? [];
    if (!all.every((c) => evaluateClause(c, props))) return false;

    const any = filter.any ?? [];
    if (any.length > 0 && !any.some((c) => evaluateClause(c, props))) return false;

    const none = filter.none ?? [];
    if (none.some((c) => evaluateClause(c, props))) return false;

    return true;
}

/**
 * Check a filter against what the event kind actually DECLARES, returning every
 * problem rather than the first — an author fixing a Wish wants the whole list.
 *
 * This is why registry entries carry props at all. Without it, `sizeBtyes > 5MB`
 * is a Wish that looks armed, never fires, and gives nobody a reason.
 */
export function validateWishFilter(
    filter: WishFilter | undefined,
    def: WishEventDefinition,
): string[] {
    if (!filter) return [];
    const errors: string[] = [];
    const declared = new Map(def.props.map((p) => [p.key, p]));

    const groups: Array<[string, readonly WishFilterClause[] | undefined]> = [
        ['all', filter.all],
        ['any', filter.any],
        ['none', filter.none],
    ];

    for (const [groupName, clauses] of groups) {
        if (clauses === undefined) continue;
        if (!Array.isArray(clauses)) {
            errors.push(`filter.${groupName} must be a list of clauses.`);
            continue;
        }
        (clauses as readonly WishFilterClause[]).forEach((clause, i) => {
            const where = `filter.${groupName}[${i}]`;
            if (!clause || typeof clause.prop !== 'string') {
                errors.push(`${where} names no prop.`);
                return;
            }
            const op = clause.op;
            if (!isWishFilterOp(op)) {
                errors.push(`${where}: unknown operator "${String(op)}".`);
                return;
            }
            const prop = declared.get(clause.prop);
            if (!prop) {
                errors.push(
                    `${where}: "${def.id}" emits no prop "${clause.prop}" ` +
                        `(it emits ${def.props.map((p) => p.key).join(', ') || 'nothing'}).`,
                );
                return;
            }
            const spec = OPS[op];
            if (!spec.accepts.has(prop.type)) {
                errors.push(
                    `${where}: "${op}" cannot be applied to ${prop.type} prop "${prop.key}".`,
                );
                return;
            }
            if (spec.listValue !== Array.isArray(clause.value)) {
                errors.push(
                    spec.listValue
                        ? `${where}: "${op}" needs a list of values.`
                        : `${where}: "${op}" needs a single value, not a list.`,
                );
                return;
            }
            const values = Array.isArray(clause.value)
                ? (clause.value as readonly WishPropValue[])
                : [clause.value as WishPropValue];
            for (const v of values) {
                if (typeof v !== prop.type) {
                    errors.push(
                        `${where}: "${prop.key}" is a ${prop.type}; compared against ${typeof v}.`,
                    );
                    break;
                }
            }
            if (op === 'matches' && typeof clause.value === 'string') {
                try {
                    new RegExp(clause.value);
                } catch (e) {
                    errors.push(
                        `${where}: not a valid regular expression — ` +
                            `${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            }
        });
    }

    return errors;
}
