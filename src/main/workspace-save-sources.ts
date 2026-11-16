import type { IssueWatchSetting } from '../core/issue-watch.js';
import type { ServiceInstance } from '../core/services.js';
import { withElements, type ElementSources } from '../core/workspace-elements.js';
import type { LiveModel } from '../core/workspace-save.js';

/**
 * WHAT THE WORKSPACE HOLDS THAT A SAVE DECLARES (Tynn #756, PR3): its service engines, its own settings, its default agent
 * and the agents' IssueWatch choices, read from the host's registries. Reads only; nothing here changes any of them.
 */

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

export function elementSourcesFor(ports: SourcePorts, workspaceId: string): ElementSources {
    const agents = ports.registry.listAgents().filter((a) => a.workspaceId === workspaceId);
    const defaultId = ports.registry.defaultAgentOf(workspaceId);
    return {
        services: ports.services.list(),
        workspace: {
            overrides: ports.settings.workspaceValues(workspaceId),
            defaultAgent: agents.find((a) => a.id === defaultId)?.name ?? null,
            envFile: ports.registry.listWorkspaces().find((w) => w.id === workspaceId)?.envFile ?? null,
            mcpOff: ports.registry.workspaceMcpOff(workspaceId),
        },
        agents: agents.map((a) => ({ name: a.name, issueWatch: a.issueWatch ?? null })),
    };
}

/**
 * A live-model loader (the one Save to repo plans from) with this workspace's declarations in it: the manifest as it is on
 * disk, plus its services, workspace settings and agents' IssueWatch as they are now. No project.json is still none.
 */
export function liveModelWithElements(
    base: (workspacePath: string) => Promise<LiveModel | null>,
    sources: (workspaceId: string) => ElementSources | Promise<ElementSources>,
    workspaceId: string,
): (workspacePath: string) => Promise<LiveModel | null> {
    return async (workspacePath) => {
        const model = await base(workspacePath);
        return model === null ? null : withElements(model, await sources(workspaceId), workspaceId).model;
    };
}
