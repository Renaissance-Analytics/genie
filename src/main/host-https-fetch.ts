import type { SessionFetch } from './tynn-account.js';

export interface HostHttpsOptions {
    readonly genieCaFile?: string;
    readonly env?: NodeJS.ProcessEnv;
}
/** RED STUB: Node's own fetch, which is what the host would have had. */
export function hostHttpsFetch(_options: HostHttpsOptions = {}): SessionFetch {
    return (url, init) => globalThis.fetch(url, init as never) as never;
}
