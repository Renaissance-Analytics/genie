/**
 * WHAT A COST FIGURE MEANS (Tynn #747). RED stub: today's words, no title.
 */
export interface CostWords {
    readonly text: string;
    readonly title: string;
}

export type CostScope = 'this turn' | 'this session';

export function costWords(usd: number, scope: CostScope, _onPlan: boolean): CostWords {
    return { text: `$${usd.toFixed(2)} ${scope}`, title: '' };
}
