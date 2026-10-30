/**
 * STRUCTURAL SHARING (genie#1340): `next`, with every part that is EQUAL to the same part of `prev` replaced by `prev`'s
 * own object — so identity means "unchanged", and a memoised view keyed on a part skips when the part did not change.
 *
 * Why it is needed: main sends the estate as a structured clone 20 times a second while any agent works, so every push
 * is a NEW object graph, equal or not. A view handed `snapshot.workspaces.find(…)` got a new object each time and redrew,
 * and its effects keyed on it ran again (a files IPC per push). Shared, the workspace is the same object until it changes.
 *
 * - Plain objects and arrays are compared member by member — arrays by position, then by `id` for an element that
 *   moved. Anything else (a class instance, a Map, a function, a React element) is equal only to itself.
 * - O(size of `next`), and O(1) where `prev` and `next` are already the same object.
 * - Never mutates either argument.
 */
export function share<T>(prev: unknown, next: T): T {
    return shareAny(prev, next) as T;
}

function isPlain(v: unknown): v is Record<string, unknown> {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    // A React element is a plain object whose owner is a fiber — a cyclic graph that is not data. Equal only to itself.
    if ('$$typeof' in v) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function idOf(v: unknown): string | null {
    return isPlain(v) && typeof v['id'] === 'string' ? v['id'] : null;
}

function shareAny(prev: unknown, next: unknown): unknown {
    if (Object.is(prev, next)) return prev;
    if (Array.isArray(prev) && Array.isArray(next)) return shareArray(prev, next);
    if (isPlain(prev) && isPlain(next)) return shareObject(prev, next);
    return next;
}

function shareArray(prev: readonly unknown[], next: readonly unknown[]): readonly unknown[] {
    // By POSITION first, and an element that is the same object there costs one comparison — a ledger of thousands of
    // rows with one appended is thousands of identity checks, nothing more. An element whose id moved (a reorder of agents,
    // workspaces, deck items) is matched by id, from a map built only when one is met.
    let byId: Map<string, unknown> | null = null;
    let same = prev.length === next.length;
    const out = next.map((v, i) => {
        const at = prev[i];
        if (Object.is(at, v)) return at;
        let before = at;
        const id = idOf(v);
        if (id !== null && idOf(at) !== id) {
            byId ??= new Map(prev.flatMap((p) => { const pid = idOf(p); return pid === null ? [] : [[pid, p] as const]; }));
            before = byId.get(id);
        }
        const kept = shareAny(before, v);
        if (kept !== at) same = false;
        return kept;
    });
    return same ? prev : out;
}

function shareObject(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
        const kept = Object.prototype.hasOwnProperty.call(prev, k) ? shareAny(prev[k], next[k]) : next[k];
        if (!Object.prototype.hasOwnProperty.call(prev, k) || kept !== prev[k]) same = false;
        out[k] = kept;
    }
    return same ? prev : out;
}
