/** RED-FIRST STUB (test/relay-connecting-ui.test.tsx): the shapes only; built in the next commit. */
export type RelayStep = 'tynn' | 'relay' | 'host';
export type RelayConnect =
    | { readonly kind: 'working'; readonly step: RelayStep }
    | { readonly kind: 'failed'; readonly step: RelayStep; readonly reason: string; readonly offline?: boolean };
export interface RelayConnectView {
    readonly title: string;
    readonly steps: ReadonlyArray<{ readonly step: RelayStep; readonly label: string; readonly status: 'done' | 'working' | 'failed' | 'waiting' }>;
    readonly problem: string | null;
}
export function offlineSentence(_name: string | null): string {
    throw new Error('offlineSentence: not built yet (red-first stub)');
}
export function relayConnectView(_name: string | null, _state: RelayConnect): RelayConnectView {
    throw new Error('relayConnectView: not built yet (red-first stub)');
}
