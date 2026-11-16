/** Inert stub (RED): a clone's workspace settings applied where it has chosen nothing (Tynn #756, PR8). The implementation lands after the tests are seen failing. */

export interface RestorePorts {
    agentsOf(workspaceId: string): readonly { id: string; name: string }[];
    overridden(workspaceId: string): Readonly<Record<string, unknown>>;
    setSetting(workspaceId: string, key: string, value: string): Promise<unknown>;
    defaultAgentOf(workspaceId: string): string | null;
    setDefaultAgent(workspaceId: string, agentId: string): Promise<unknown>;
    envFileOf(workspaceId: string): string | null;
    defaultEnvFile(): string;
    setEnvFile(workspaceId: string, file: string): Promise<unknown>;
    mcpOff(workspaceId: string): readonly string[];
    setMcpServer(workspaceId: string, name: string, on: boolean): Promise<unknown>;
}

export interface SettingsRestore {
    readonly applied: string[];
    readonly kept: string[];
    readonly waiting: string[];
    readonly ignored: string[];
}

export async function restoreWorkspaceSettings(_manifest: unknown, _workspaceId: string, _ports: RestorePorts): Promise<SettingsRestore> {
    return { applied: [], kept: [], waiting: [], ignored: [] };
}
