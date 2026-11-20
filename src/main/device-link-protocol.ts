/** Stub (2f-2 RED). */
export function deviceLinkProtocol(_ports: {
    link: unknown;
    role: { role(): unknown; said(): unknown; why(): string | null; reread(): Promise<void> };
    wordTynnRefusal: (refusal: { ok: false; reason: string; refusedByTynn?: true }) => Promise<{ ok: false; reason: string }>;
    openBrowser: (args: unknown[]) => Promise<unknown>;
    remoteVia: (key: string, port: number, ca: string | null) => void;
}): { call(owner: string, method: string, args: readonly unknown[]): Promise<unknown>; dropOwner(owner: string): void; events(event: unknown): unknown[] } {
    throw new Error('2f-2: not built yet');
}
