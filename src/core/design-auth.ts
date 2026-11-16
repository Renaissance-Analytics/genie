import { designLoginRefused } from './design-login.js';
import type { StreamEvent } from './stream-event.js';

/**
 * CLAUDE DESIGN'S AUTHORIZATION, ONE FOR THE MACHINE (Tynn #480, Accounts S7; decision 5). Per-home Design authorization is
 * undocumented and unmeasured (spec M3), and Claude Design's own refusal says it is per machine ("headless and SDK runs here
 * then reuse that authorization"), so Genie keeps ONE state, offers ONE "Design sign-in" in the provider's one home (Tynn
 * #753), and says so. It never claims more than it saw:
 *
 *  - a call refused for want of `/design-login` is `needed` (Not authorized), and remembers WHICH operation it was;
 *  - the Design terminal ending is `login-ran`: still Not authorized, because a closed window proves nothing;
 *  - only a later SUCCESS of that same operation is `authorized`; any other tool succeeding is not evidence;
 *  - a refusal at any time is `needed` again.
 *
 * A refusal that names no operation can never be matched, so it stays Not authorized until a refusal that does.
 */
export type DesignAuthState = 'unknown' | 'needed' | 'login-ran' | 'authorized';

export interface DesignAuth {
    readonly state: DesignAuthState;
    /** The operation that needed the authorization (its tool name, else its title); `null` = not known. */
    readonly operation: string | null;
}

export type DesignAuthEvent =
    | { readonly kind: 'refused'; readonly operation: string | null }
    | { readonly kind: 'login-ended' }
    | { readonly kind: 'tool-completed'; readonly operation: string };

export interface DesignAuthView { readonly state: DesignAuthState; readonly authorized: boolean; readonly words: string }

export const DESIGN_AUTH_UNKNOWN: DesignAuth = { state: 'unknown', operation: null };

export function designAuthNext(state: DesignAuth, event: DesignAuthEvent): DesignAuth {
    if (event.kind === 'refused') return { state: 'needed', operation: event.operation ?? state.operation };
    if (event.kind === 'login-ended') return state.state === 'authorized' ? state : { state: 'login-ran', operation: state.operation };
    if ((state.state === 'needed' || state.state === 'login-ran') && state.operation !== null && event.operation === state.operation) {
        return { state: 'authorized', operation: state.operation };
    }
    return state;
}

const WORDS: Readonly<Record<DesignAuthState, string>> = {
    unknown: 'Not checked yet',
    needed: 'Not authorized',
    'login-ran': 'Not authorized yet: retry what needed it',
    authorized: 'Authorized',
};

export function designAuthView(state: DesignAuth): DesignAuthView {
    return { state: state.state, authorized: state.state === 'authorized', words: WORDS[state.state] };
}

/**
 * WHICH OPERATION A TOOL UPDATE IS (Tynn #480). An ACP tool call arrives as several updates, and a later one may carry no name
 * (the measured refusal's row had `name: null`), so each call's name (else title) is remembered from the first update that
 * has one, and forgotten once the call has ended. Reports a refusal for want of `/design-login`, and any call that completes.
 */
export class DesignOperationTracker {
    readonly #names = new Map<string, string>();

    track(event: StreamEvent): DesignAuthEvent | null {
        if (event.kind !== 'tool') return null;
        const own = event.name ?? event.title;
        if (own && event.toolCallId) this.#names.set(event.toolCallId, own);
        const operation = own ?? this.#names.get(event.toolCallId) ?? null;
        if (event.status === 'completed' || event.status === 'failed') this.#names.delete(event.toolCallId);
        if (designLoginRefused(event)) return { kind: 'refused', operation };
        if (event.status === 'completed' && operation !== null) return { kind: 'tool-completed', operation };
        // A runaway agent's thousands of calls that never end must not grow this without bound.
        if (this.#names.size > 512) this.#names.delete(this.#names.keys().next().value as string);
        return null;
    }
}

function designAuthOf(raw: unknown): DesignAuth {
    if (typeof raw !== 'object' || raw === null) return DESIGN_AUTH_UNKNOWN;
    const v = raw as Record<string, unknown>;
    const state = v['state'];
    if (state !== 'unknown' && state !== 'needed' && state !== 'login-ran' && state !== 'authorized') return DESIGN_AUTH_UNKNOWN;
    const operation = typeof v['operation'] === 'string' && v['operation'] !== '' ? v['operation'] : null;
    return { state, operation };
}

/** The machine's one state, in genie-host, kept across a restart. A saved state that is not one is Not checked. */
export class DesignAuthBook {
    #state: DesignAuth;
    readonly #save: (state: DesignAuth) => void;
    readonly #listeners = new Set<() => void>();

    constructor(load: () => unknown, save: (state: DesignAuth) => void) {
        this.#save = save;
        this.#state = designAuthOf(((): unknown => { try { return load(); } catch { return undefined; } })());
    }

    apply(event: DesignAuthEvent): void {
        // A completed call is only evidence while one is awaited: anything else costs a comparison.
        if (event.kind === 'tool-completed' && this.#state.state !== 'needed' && this.#state.state !== 'login-ran') return;
        const next = designAuthNext(this.#state, event);
        if (next.state === this.#state.state && next.operation === this.#state.operation) return;
        this.#state = next;
        try { this.#save(next); } catch { /* the host logs its own write failures */ }
        for (const l of [...this.#listeners]) l();
    }

    view(): DesignAuthView { return designAuthView(this.#state); }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}
