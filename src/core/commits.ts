/** A commit git reported, with the registry slug of the repo it is in. `at` is the committer time, epoch ms. */
export interface RepoCommit {
    readonly repo: string;
    readonly sha: string;
    readonly subject: string;
    readonly author: string;
    readonly at: number;
}
