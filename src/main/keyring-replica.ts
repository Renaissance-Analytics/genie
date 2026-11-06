import type { KeyringView } from './linux-keyring.js';
import type { KeyringDump } from './keyring-service.js';

/** The keyring card as a window sees it (P3.4 cut c): the host's last word, and a button that runs there. With no host yet: no card. */
export class KeyringReplica {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    #dump: KeyringDump = { view: null, canKeepSecrets: true };
    readonly #listeners = new Set<() => void>();

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) { this.#call = call; }

    rebase(dump: KeyringDump): void {
        const changed = JSON.stringify(dump) !== JSON.stringify(this.#dump);
        this.#dump = dump;
        if (changed) for (const listener of [...this.#listeners]) listener();
    }

    view(): KeyringView | null { return this.#dump.view; }
    /** The host's word about what an unlock set going (Tynn story #388); null = none. */
    notice(): string | null { return this.#dump.notice ?? null; }
    canKeepSecrets(): boolean { return this.#dump.canKeepSecrets; }
    onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
    async fix(): Promise<void> { await this.#call('fix', []); }
    /** The card's Cancel while the keyring's unlock dialog is up (Tynn story #388). */
    async cancel(): Promise<void> { await this.#call('cancel', []); }
}
