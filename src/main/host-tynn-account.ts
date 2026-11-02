import type { TynnAccountPorts } from './tynn-account.js';
export interface HostTynnOptions { readonly file: string; readonly host: () => string; readonly secrets: unknown; readonly fetch?: TynnAccountPorts['fetch'] }
/** RED STUB (cut c's first commit). */
export function hostTynnPorts(options: HostTynnOptions): TynnAccountPorts {
    return { file: options.file, host: options.host, cipher: { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' },
        cookies: { set: async () => {}, get: async () => null, clear: async () => {} }, fetch: options.fetch as TynnAccountPorts['fetch'] };
}
