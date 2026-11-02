import { signedOutGithubView, type GithubView } from '../core/github.js';
/** RED STUB. */
export class GithubAccountReplica {
    view(): GithubView { return signedOutGithubView(null); }
    onChange(_listener: () => void): () => void { return () => {}; }
    async startSignIn(): Promise<void> {}
    cancelSignIn(): void {}
    openFromHost(_url: string): void {}
    async gitClone(_url: string, _into: string, _branch: string | null | undefined): Promise<void> { throw new Error('not built'); }
    async gitAddSubmodule(_envelope: string, _url: string, _at: string, _branch: string | null, _local: boolean | undefined): Promise<string | null> { throw new Error('not built'); }
    async gitPushMain(_path: string, _url: string): Promise<void> { throw new Error('not built'); }
}
