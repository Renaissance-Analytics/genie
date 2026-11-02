import type { GithubAccount } from './github-account.js';
export interface GithubGitPorts {
    clone(url: string, into: string, auth: unknown, branch: string | null | undefined): Promise<void>;
    addSubmodule(envelope: string, url: string, at: string, branch: string | null, auth: unknown, local: boolean | undefined): Promise<string | null>;
    pushMain(path: string, auth: unknown): Promise<void>;
}
/** RED STUB. */
export class GithubAccountService {
    constructor(readonly account: GithubAccount, _options: { git?: GithubGitPorts } = {}) {}
    dump(): unknown { return null; }
    onEvent(_listener: (event: unknown) => void): () => void { return () => {}; }
    call(_method: string, _args: readonly unknown[]): Promise<unknown> { return Promise.reject(new Error('not built')); }
}
