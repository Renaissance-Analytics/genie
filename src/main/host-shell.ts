export type HostShellAnswer = { ok: true } | { ok: false; reason: string };
export interface HostShell {
    open(workspaceId: string, path: string): Promise<HostShellAnswer>;
    reveal(workspaceId: string, path: string): Promise<HostShellAnswer>;
}

export function hostShellFor(_ports: { absolute(workspaceId: string, path: string): string | null; windowOp(op: string, args: unknown[]): Promise<unknown>; hostName(): string }): HostShell {
    throw new Error('2f-1: not built yet');
}
