/** Stub (2f-2 RED). */
export function deviceChannels(_ports: { call(method: string, ...args: unknown[]): Promise<unknown>; on(listener: (payload: unknown) => void): () => void }): {
    open(url: string): Promise<unknown>; openRelay(id: string): Promise<unknown>; send(channel: string, text: string): void; close(channel: string): void;
    onMessage(l: (c: string, t: string) => void): () => void; onClosed(l: (c: string, r: string | null) => void): () => void; onOpenStep(l: (id: string, step: 'relay') => void): () => void;
    openBrowser(channel: string, address: string | null, hosts: readonly string[], view: unknown): Promise<unknown>; lost(reason: string): void;
} {
    throw new Error('2f-2: not built yet');
}
