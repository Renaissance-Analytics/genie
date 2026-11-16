import type { CloneOffer } from './clone-offers.js';

/** The offers dialog as data (Tynn #756, the offers UI). Inert until built. */
export interface OfferRow { id: string; summary: string; change: 'new' | 'changed'; incoming: string; local: string | null; commands: string[]; needsTrust: boolean; canApply: boolean; busy: boolean; note: string | null }
export interface OffersDialogView { loading: boolean; empty: boolean; error: string | null; rows: OfferRow[] }

export function offerCommands(_offer: CloneOffer): string[] {
    return [];
}

export function offersDialogView(_input: { offers: CloneOffer[] | null; trusted: boolean; busy: string | null; error: string | null; notes: Record<string, string> }): OffersDialogView {
    return { loading: false, empty: false, error: null, rows: [] };
}
