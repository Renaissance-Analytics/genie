/** RED STUB (P9 outside communication): the shapes the tests name; nothing is built yet. */
export type ExchangeDirection = 'in' | 'out' | 'both';
export interface StationExchange { readonly station: string; readonly name: string; readonly direction: ExchangeDirection }
export class StationExchanges {
    constructor(_options: unknown = {}) {}
    begin(_station: string, _name: string, _direction: 'in' | 'out'): () => void { throw new Error('not built'); }
    pulse(_station: string, _name: string, _direction: 'in' | 'out'): void { throw new Error('not built'); }
    view(): StationExchange[] { throw new Error('not built'); }
    onChange(_listener: () => void): () => void { throw new Error('not built'); }
}
export function readStationExchanges(_raw: unknown): StationExchange[] { throw new Error('not built'); }
