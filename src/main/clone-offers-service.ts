import type { CloneOffer } from '../core/clone-offers.js';
import type { CloneWatch } from './clone-watch-host.js';

/**
 * The offers a clone's repo brings (Tynn #756, the offers UI), served from genie-host, which owns the watcher, to a window over the
 * engine link and to the host's own API while no window is open. A window may list and apply, and nothing else: the looking is the
 * host's.
 */
export type CloneOffersReply = { ok: true; offers: CloneOffer[]; trusted: boolean } | { ok: false; reason: string };
export type CloneApplyReply = { ok: true } | { ok: false; reason: string };

export interface CloneOffersParts {
    readonly watch: Pick<CloneWatch, 'pass' | 'list' | 'apply'>;
    readonly trusted: (workspaceId: string) => boolean;
}

const WINDOW_CALLS: ReadonlySet<string> = new Set(['list', 'apply']);
const STARTING = { ok: false as const, reason: 'the host has not started watching the repo yet; try again in a moment' };

export class CloneOffersService {
    #parts: CloneOffersParts | null = null;

    /** Served at once; the watcher is attached when the host has made it. */
    attach(parts: CloneOffersParts): void {
        this.#parts = parts;
    }

    async call(method: string, args: readonly unknown[]): Promise<CloneOffersReply | CloneApplyReply> {
        if (!WINDOW_CALLS.has(method)) throw new Error(`a window cannot call cloneOffers.${method}`);
        const parts = this.#parts;
        if (!parts) return STARTING;
        const workspaceId = typeof args[0] === 'string' ? args[0] : '';
        if (method === 'list') {
            // One look first, so what the person opens is what the repo says now, not what it said 30 seconds ago.
            await parts.watch.pass().catch(() => {});
            return { ok: true, offers: parts.watch.list(workspaceId), trusted: parts.trusted(workspaceId) };
        }
        return parts.watch.apply(workspaceId, typeof args[1] === 'string' ? args[1] : '');
    }
}
