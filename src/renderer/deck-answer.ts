import type { DeckItem } from '../core/deck.js';
import type { FeatureData } from './features.js';
import type { GenieBridge } from './bridge.js';

/** TODO(#652): stub — a filled question form, answered. */
export function answerDeckForm(_features: Pick<GenieBridge['features'], 'act'>, _item: DeckItem, _selections: string[][], _notes: string[]): Promise<FeatureData | null> {
    return Promise.resolve(null);
}
