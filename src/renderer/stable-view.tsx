import { memo, useInsertionEffect, useRef, type ComponentType, type FunctionComponent } from 'react';
import { share } from '../core/share.js';

/**
 * A VIEW THAT DRAWS WHEN WHAT IT SHOWS CHANGED (genie#1340).
 *
 * The Shell re-renders on every estate push — twenty a second while any agent works — and hands each view props built
 * afresh: inline handlers, objects looked up in the new snapshot, `{ kind: 'here' }` literals. `memo` alone compares those
 * by identity and so never skips. Measured on omarchy-test with eleven agents streaming, the Agent view drew again for
 * every push of every agent, and react-fancy's VirtualList measured every visible row each time.
 *
 * At this boundary:
 *  - every FUNCTION prop, and every function member of a plain-object prop (`ops.onRestart`), is handed down as a stable
 *    proxy that calls the LATEST one. A handler is behaviour, not data: which closure is current must not redraw a view,
 *    and the view must never call a stale one. The latest props are recorded in an insertion effect, so a handler called
 *    from any layout or passive effect of the commit, or from an event after it, reaches the props of that commit;
 *  - every other prop is shared structurally with the last one handed down (core/share.ts): equal content keeps its
 *    identity, so `memo`'s shallow compare sees what actually changed — and so do the view's own effects and memos.
 *
 * A function prop is therefore never a way to make the view draw: a render prop whose OUTPUT depends on data would go
 * stale. Neither the Agent view nor the chat takes one.
 */
type Fn = (...args: unknown[]) => unknown;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    if (v === null || typeof v !== 'object' || Array.isArray(v) || '$$typeof' in v) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** The props to hand a memoised view, and the latest props its handlers reach. One per mounted view. */
export class StableProps<P extends object> {
    #latest: P | null = null;
    #last: P | null = null;
    readonly #proxies = new Map<string, Fn>();

    /** What the memoised view is given for `props`: handlers as stable proxies, data shared with the last call. */
    pass(props: P): P {
        // Until the first commit the handlers reach the props of the first render.
        this.#latest ??= props;
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
            if (typeof value === 'function') {
                out[key] = this.#proxy([key]);
            } else if (isPlainObject(value) && Object.values(value).some((m) => typeof m === 'function')) {
                const inner: Record<string, unknown> = {};
                for (const [member, m] of Object.entries(value)) inner[member] = typeof m === 'function' ? this.#proxy([key, member]) : m;
                out[key] = inner;
            } else {
                out[key] = value;
            }
        }
        const shared = share(this.#last, out as P);
        this.#last = shared;
        return shared;
    }

    /** These props are on screen: from now on every handler calls theirs. */
    commit(props: P): void {
        this.#latest = props;
    }

    #proxy(path: readonly string[]): Fn {
        const key = path.join('\u0000');
        let proxy = this.#proxies.get(key);
        if (!proxy) {
            proxy = (...args: unknown[]): unknown => {
                let target: unknown = this.#latest;
                for (const step of path) target = target === null || target === undefined ? undefined : (target as Record<string, unknown>)[step];
                return typeof target === 'function' ? (target as Fn)(...args) : undefined;
            };
            this.#proxies.set(key, proxy);
        }
        return proxy;
    }
}

/**
 * `value`, as the same object as last render's while it is EQUAL to it (core/share.ts) — for a value a context hands to
 * every consumer: a new-but-equal value would redraw each of them, memoised or not.
 */
export function useShared<T>(value: T): T {
    const last = useRef<T>(value);
    const shared = share(last.current, value);
    last.current = shared;
    return shared;
}

/** `Inner`, drawn only when a prop it shows changed (see above). */
export function stableView<P extends object>(Inner: ComponentType<P>, name: string): FunctionComponent<P> {
    const Memo = memo(Inner) as unknown as ComponentType<P>;
    function Stable(props: P) {
        const keep = useRef<StableProps<P> | null>(null);
        keep.current ??= new StableProps<P>();
        const passed = keep.current.pass(props);
        const stable = keep.current;
        useInsertionEffect(() => { stable.commit(props); });
        return <Memo {...passed} />;
    }
    Stable.displayName = name;
    return Stable;
}
