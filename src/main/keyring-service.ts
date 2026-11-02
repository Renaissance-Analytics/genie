import type { KeyringView, LinuxKeyring } from './linux-keyring.js';
export interface KeyringDump { readonly view: KeyringView | null; readonly canKeepSecrets: boolean }
/** RED STUB. */
export class KeyringService {
    constructor(_keyring: LinuxKeyring | Promise<LinuxKeyring | null>, _options: { onReady?: () => void } = {}) {}
    dump(): KeyringDump { return { view: null, canKeepSecrets: true }; }
    onEvent(_listener: (dump: KeyringDump) => void): () => void { return () => {}; }
    call(_method: string, _args: readonly unknown[]): Promise<unknown> { return Promise.reject(new Error('not built')); }
}
