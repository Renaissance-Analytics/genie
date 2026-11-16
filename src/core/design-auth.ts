import type { StreamEvent } from './stream-event.js';

/** ACCOUNTS S7 (Tynn #480): RED stub. */
export type DesignAuthState = 'unknown' | 'needed' | 'login-ran' | 'authorized';
export interface DesignAuth { readonly state: DesignAuthState; readonly operation: string | null }
export type DesignAuthEvent =
    | { readonly kind: 'refused'; readonly operation: string | null }
    | { readonly kind: 'login-ended' }
    | { readonly kind: 'tool-completed'; readonly operation: string };
export interface DesignAuthView { readonly state: DesignAuthState; readonly authorized: boolean; readonly words: string }

export const DESIGN_AUTH_UNKNOWN: DesignAuth = { state: 'unknown', operation: null };
export function designAuthNext(state: DesignAuth, _event: DesignAuthEvent): DesignAuth { return state; }
export function designAuthView(_state: DesignAuth): DesignAuthView { return { state: 'unknown', authorized: false, words: '' }; }

export class DesignOperationTracker {
    track(_event: StreamEvent): DesignAuthEvent | null { return null; }
}

export class DesignAuthBook {
    constructor(_load: () => unknown, _save: (state: DesignAuth) => void) {}
    apply(_event: DesignAuthEvent): void {}
    view(): DesignAuthView { return designAuthView(DESIGN_AUTH_UNKNOWN); }
}
