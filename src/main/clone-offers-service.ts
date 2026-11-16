import type { CloneOffer } from '../core/clone-offers.js';

/** The offers, reachable from a window (Tynn #756, the offers UI). Inert until built. */
export type CloneOffersReply = { ok: true; offers: CloneOffer[]; trusted: boolean } | { ok: false; reason: string };

export class CloneOffersService {
    attach(_ports: unknown): void {}

    async call(_method: string, _args: unknown[]): Promise<unknown> {
        throw new Error('not built yet');
    }
}
