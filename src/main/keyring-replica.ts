import type { KeyringView } from './linux-keyring.js';
/** RED STUB. */
export class KeyringReplica {
    view(): KeyringView | null { return null; }
    canKeepSecrets(): boolean { return true; }
    onChange(_listener: () => void): () => void { return () => {}; }
    async fix(): Promise<void> { throw new Error('not built'); }
}
