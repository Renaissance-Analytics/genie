import type { DeckItem } from '../core/deck.js';
import type { FeatureData } from './features.js';
import type { GenieBridge } from './bridge.js';

/**
 * A FILLED QUESTION FORM, ANSWERED (Tynn #652): the one call the desktop's Deck and the phone both make — the labels picked
 * and one note per question, as one feature action. main checks it (a question with neither an option nor a note, a label
 * that is not an option) and rejects with the reason, which the caller says beside the Answer button.
 */
export function answerDeckForm(features: Pick<GenieBridge['features'], 'act'>, item: DeckItem, selections: string[][], notes: string[]): Promise<FeatureData> {
    return features.act({ kind: 'deck.answerForm', item, selections, notes, note: '' });
}
