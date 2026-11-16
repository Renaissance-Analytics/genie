import type { ElementSources } from '../core/workspace-elements.js';
import type { ServiceInstance } from '../core/services.js';
import type { IssueWatchSetting } from '../core/issue-watch.js';

/** Inert stub (RED): what the workspace holds that a save declares (Tynn #756 PR3). */

export interface SourcePorts {
    readonly services: { list(): readonly ServiceInstance[] };
    readonly settings: { workspaceValues(workspaceId: string): Readonly<Record<string, boolean | string>> };
    readonly registry: {
        defaultAgentOf(workspaceId: string): string | null;
        workspaceMcpOff(workspaceId: string): string[];
        listAgents(): readonly { id: string; name: string; workspaceId: string; issueWatch?: IssueWatchSetting }[];
        listWorkspaces(): readonly { id: string; envFile?: string }[];
    };
}

export function elementSourcesFor(_ports: SourcePorts, _workspaceId: string): ElementSources {
    return { services: [], workspace: { overrides: {}, defaultAgent: null, envFile: null, mcpOff: [] }, agents: [] };
}
