/** RED STUB (P9 x-station mail): nothing is built yet. */
export class StationRefused extends Error {}
export interface StationLink { call(method: string, arg: unknown): Promise<unknown>; close(): void }
export class CrossStationHost {
    constructor(_ports: unknown) {}
    start(): void {}
    stop(): void {}
    async peers(_caller: unknown): Promise<Array<{ address: string; reachable: boolean }>> { throw new Error('not built'); }
    async send(_caller: unknown, _to: string, _text: string): Promise<unknown> { throw new Error('not built'); }
    async handle(_method: string, _arg: unknown, _from: { station: string }): Promise<unknown> { throw new Error('not built'); }
}
