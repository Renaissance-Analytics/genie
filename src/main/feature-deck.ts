import { dismissableStale, isDismissable, type DeckItem } from '../core/deck.js';
import type { FeatureAction } from '../renderer/features.js';
import type { AttentionStore } from './attention-store.js';
import { answerDeck, type DeckAnswerPorts } from './deck-answer.js';

/** The same durable Deck owners for the window and genie-host. UI error effects are caller-bound ports. */
export interface DeckFeatureServices extends DeckAnswerPorts {
    readonly attention: DeckAnswerPorts['attention'] & Pick<AttentionStore, 'dismiss' | 'dismissMany' | 'dismissOlderThan'>;
    deckItems(): readonly DeckItem[];
}

export async function applyDeckFeatureAction(services: DeckFeatureServices, action: FeatureAction): Promise<boolean> {
    switch (action.kind) {
        case 'deck.answer':
        case 'deck.answerForm': {
            // One answer for the window and genie-host (deck-answer.ts, Tynn #551).
            await answerDeck(action, services);
            break;
        }
        case 'deck.dismiss':
            // An agent's question, put aside WITHOUT an answer: it leaves the Deck and the question window, and the asker is
            // mailed that it was dismissed (attention-store.ts). An approval or a forwarded question is not dismissable.
            if (!isDismissable(action.item)) throw new Error('only an agent’s question can be dismissed; an approval is answered with its own options');
            // The person's notes travel with it (one per question; anything that is not a string is no note).
            await services.attention.dismiss(action.item.id, Array.isArray(action.notes) ? action.notes.map((n) => (typeof n === 'string' ? n : '')) : []);
            break;
        case 'deck.dismissStale': {
            // "Dismiss all stale": the ids the person SAW marked stale, re-checked against the Deck now — a question that is
            // no longer pending, or no longer stale, stays. Each asker is mailed once (attention-store.ts).
            const seen = new Set(Array.isArray(action.ids) ? action.ids.filter((id): id is string => typeof id === 'string') : []);
            const still = dismissableStale(services.deckItems()).filter((i) => seen.has(i.id));
            // Never a silent no-op (Tynn #600): when none of them is still a stale question here, the person is told.
            if (still.length === 0) throw new Error('None of these questions is still waiting as a stale one here, so nothing was dismissed. Look at the Deck again.');
            await services.attention.dismissMany(still.map((i) => i.id));
            break;
        }
        case 'deck.dismissOlder':
            // "Dismiss all older than 1 day" — the store's clock decides what is old, each asker mailed once.
            await services.attention.dismissOlderThan(action.olderThanMs);
            break;
        default: return false;
    }
    return true;
}
