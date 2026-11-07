import { useEffect, useReducer, useRef, useState } from 'react';
import type { ActOutcome, FeatureAction } from './features.js';

/**
 * A SITE BUTTON NEVER FIRES TWICE AND NEVER GOES SILENT (genie#1393). The owner, after a Retry: "I have no idea if
 * anything is actually happening when I clicked the button … other users might not realize anything is happening and
 * spam the restart button, I almost did."
 *
 * A Start, Stop or Restart is PENDING on its site from the click until main answers: the row disables its controls and
 * says the step (SiteRow). Another click on that site meanwhile is ignored here, and main joins a second Restart too
 * (site-manager `restart({ join })`), so neither a double click nor a person and an agent at once starts two. A refusal
 * is kept on the site with the action that met it, so the row says why and offers Retry; never only in the console.
 */
export type SitePending = 'start' | 'stop' | 'restart';

export interface SiteRefusal {
    readonly action: FeatureAction;
    readonly reason: string;
}

const PENDING_OF: Partial<Record<FeatureAction['kind'], SitePending>> = {
    'hosting.startSite': 'start',
    'hosting.stopSite': 'stop',
    'hosting.restartSite': 'restart',
};

/** Electron wraps a handler's throw as "Error invoking remote method '<channel>': Error: <reason>". */
export function refusalReason(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

export class SiteActions {
    readonly #send: (action: FeatureAction) => void | Promise<ActOutcome | unknown>;
    readonly #pending = new Map<string, SitePending>();
    readonly #refusals = new Map<string, SiteRefusal>();
    readonly #listeners = new Set<() => void>();

    constructor(send: (action: FeatureAction) => void | Promise<ActOutcome | unknown>) {
        this.#send = send;
    }

    /** Send `action`; false when it was ignored because this site already has one in flight. */
    click(action: FeatureAction): boolean {
        const kind = PENDING_OF[action.kind];
        const siteId = 'siteId' in action ? action.siteId : undefined;
        if (kind === undefined || siteId === undefined) {
            void this.#send(action);
            return true;
        }
        if (this.#pending.has(siteId)) return false;
        this.#pending.set(siteId, kind);
        this.#refusals.delete(siteId);
        this.#emit();
        let answer: void | Promise<unknown>;
        try {
            answer = this.#send(action);
        } catch (error) {
            answer = Promise.reject(error);
        }
        Promise.resolve(answer)
            .then(
                (outcome) => {
                    if (outcome && typeof outcome === 'object' && 'ok' in outcome && (outcome as ActOutcome).ok === false) {
                        this.#refusals.set(siteId, { action, reason: (outcome as unknown as { reason: string }).reason });
                    }
                },
                (error: unknown) => { this.#refusals.set(siteId, { action, reason: refusalReason(error) }); },
            )
            .finally(() => {
                this.#pending.delete(siteId);
                this.#emit();
            });
        return true;
    }

    pending(siteId: string): SitePending | null {
        return this.#pending.get(siteId) ?? null;
    }

    refusal(siteId: string): SiteRefusal | null {
        return this.#refusals.get(siteId) ?? null;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #emit(): void {
        for (const l of this.#listeners) l();
    }
}

/** One SiteActions per surface, sending through the latest `onAction`; the surface re-renders as clicks start and end. */
export function useSiteActions(onAction: (action: FeatureAction) => void | Promise<ActOutcome | unknown>): SiteActions {
    const latest = useRef(onAction);
    latest.current = onAction;
    const [actions] = useState(() => new SiteActions((a) => latest.current(a)));
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => actions.subscribe(rerender), [actions]);
    return actions;
}
