import type { FeatureAction } from '../renderer/features.js';

/** A refused Deck action, as the lifecycle log says it (Tynn #600). Not built yet: the red commit's stand-in. */
export function deckRefusalLine(_action: FeatureAction, _error: unknown): string {
    return '';
}
