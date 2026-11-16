import type { CloneOffer } from './clone-offers.js';
import { flowTrustItems } from './workspace-flows.js';
import { processTrustItems } from './workspace-processes.js';

/**
 * THE OFFERS DIALOG, AS DATA (Tynn #756, the offers UI). What the repo says beside what this machine has, in words. A NEW offer
 * can be applied, unless it would run something and the workspace is not trusted yet: then it shows what it would run, and the
 * trust step comes first. A CHANGED offer shows its two sides and cannot be applied: Genie does not replace it.
 */
export interface OfferRow {
    readonly id: string;
    readonly summary: string;
    readonly change: 'new' | 'changed';
    /** What the repo says. */
    readonly incoming: string;
    /** What this machine has, for a changed offer. */
    readonly local: string | null;
    /** What applying it would run. */
    readonly commands: readonly string[];
    readonly needsTrust: boolean;
    readonly canApply: boolean;
    readonly busy: boolean;
    readonly note: string | null;
}

export interface OffersDialogView {
    readonly loading: boolean;
    readonly empty: boolean;
    readonly error: string | null;
    readonly rows: readonly OfferRow[];
}

export interface OffersDialogInput {
    readonly offers: readonly CloneOffer[] | null;
    readonly trusted: boolean;
    /** The offer being applied now. */
    readonly busy: string | null;
    readonly error: string | null;
    /** Why an offer was refused, by offer id. */
    readonly notes: Readonly<Record<string, string>>;
}

const SIDE_LIMIT = 1200;
export const CHANGED_NOTE = 'Genie does not replace it: it differs from what you have here. Change it by hand, or remove it here and apply the new one.';

const side = (value: unknown): string => {
    const text = JSON.stringify(value, null, 2) ?? '';
    return text.length > SIDE_LIMIT ? `${text.slice(0, SIDE_LIMIT)}…` : text;
};

/** What applying an offer would run: a flow's terminal and agent steps, a process's command or nudge. */
export function offerCommands(offer: CloneOffer): string[] {
    const file = [{ path: offer.file, value: offer.incoming }];
    const items = offer.kind === 'flow' ? flowTrustItems(file) : offer.kind === 'process' ? processTrustItems(file) : [];
    return items.flatMap((item) => [...item.commands]);
}

export function offersDialogView(input: OffersDialogInput): OffersDialogView {
    if (input.offers === null) return { loading: true, empty: false, error: input.error, rows: [] };
    const rows = input.offers.map((offer): OfferRow => {
        const commands = offerCommands(offer);
        const changed = offer.change === 'changed';
        const needsTrust = !changed && commands.length > 0 && !input.trusted;
        const busy = input.busy === offer.id;
        return {
            id: offer.id,
            summary: offer.summary,
            change: offer.change,
            incoming: side(offer.incoming),
            local: offer.local === null ? null : side(offer.local),
            commands,
            needsTrust,
            canApply: !changed && !needsTrust && !busy,
            busy,
            note: input.notes[offer.id] ?? (changed ? CHANGED_NOTE : null),
        };
    });
    return { loading: false, empty: rows.length === 0, error: input.error, rows };
}
