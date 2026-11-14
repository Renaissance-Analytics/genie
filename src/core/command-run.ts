/** Safe live ledger reference. Never carry the executor's internal credential-bearing run metadata. */
export interface CommandRunRef {
    readonly processId: string;
    readonly workspaceId: string;
    readonly command: string;
}
