// INERT STUB for the Tynn #726 RED: the exports exist and do nothing. The GREEN commit replaces it.
import type { DeckItem } from '../core/deck.js';
export type RemoteQuestionAction = { kind: 'deck.answerForm'; selections: string[][]; notes: string[] } | { kind: 'deck.dismiss'; notes: string[] };
export interface RemoteQuestionRequest { readonly id: string; readonly action: unknown }
export class RemoteQuestions {
    constructor(_ports: { send: (sender: number, request: RemoteQuestionRequest) => boolean; timeoutMs?: number }) {}
    report(_sender: number, _host: string, _items: readonly DeckItem[]): boolean { return false; }
    drop(_sender: number): boolean { return false; }
    items(): DeckItem[] { return []; }
    owns(_id: string): boolean { return false; }
    async act(_item: DeckItem, _action: RemoteQuestionAction): Promise<void> {}
    settle(_sender: number, _requestId: string, _outcome: { ok: true } | { ok: false; reason: string }): boolean { return false; }
}
