import { envFileName } from '../core/dotenv.js';
import { workspaceSettingsRestore } from '../core/workspace-elements.js';

/**
 * A CLONE'S WORKSPACE SETTINGS, APPLIED WHERE IT HAS CHOSEN NOTHING (Tynn #756, PR8). project.json's `workspace` object says how the
 * workspace's people like it set: caps and limits, the default agent (by name), the env file, MCP servers off by default. A clone
 * applies each only where the person here has not already chosen: it never overwrites an override, never replaces a default agent
 * that is set, never replaces an env file the person chose, and never turns a server ON (a repo can make Genie quieter, not looser).
 * A safety setting or an agent's capability grant someone put in the file is ignored and named, never applied.
 *
 * Declarative: nothing here runs code, so it needs no trust. A default agent that is not registered here yet WAITS (the agents are
 * offered, never automatic) and is applied when that agent is adopted (main/agent-adoption-host.ts).
 */

export interface RestorePorts {
    agentsOf(workspaceId: string): readonly { id: string; name: string }[];
    /** The workspace's own setting overrides, as the settings store keeps them: what the person (or an agent) already chose. */
    overridden(workspaceId: string): Readonly<Record<string, unknown>>;
    setSetting(workspaceId: string, key: string, value: string): Promise<unknown>;
    /** The default someone CHOSE, by id, or null: an automatic one (the first agent, Tynn #1015) is replaced. */
    chosenDefaultAgentOf(workspaceId: string): string | null;
    setDefaultAgent(workspaceId: string, agentId: string): Promise<unknown>;
    /** The env file the workspace was registered with, or null. */
    envFileOf(workspaceId: string): string | null;
    /** The env file name this machine stamps on a new workspace: a default, not a choice. */
    defaultEnvFile(): string;
    setEnvFile(workspaceId: string, file: string): Promise<unknown>;
    mcpOff(workspaceId: string): readonly string[];
    setMcpServer(workspaceId: string, name: string, on: boolean): Promise<unknown>;
}

export interface SettingsRestore {
    /** What was set: a setting's key, `defaultAgent`, `envFile`, `mcpOff:<server>`. */
    readonly applied: string[];
    /** What the person here had already chosen, and so was left as it is. */
    readonly kept: string[];
    /** What cannot be applied yet (the default agent is not registered here). */
    readonly waiting: string[];
    /** What the file held that is not applied: a safety setting, a grant, a path, a value Genie does not offer. */
    readonly ignored: string[];
}

export async function restoreWorkspaceSettings(manifest: unknown, workspaceId: string, ports: RestorePorts): Promise<SettingsRestore> {
    const out: SettingsRestore = { applied: [], kept: [], waiting: [], ignored: [] };
    const declared = typeof manifest === 'object' && manifest !== null ? (manifest as { workspace?: unknown }).workspace : undefined;
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) return out;
    const wanted = workspaceSettingsRestore(declared);
    out.ignored.push(...wanted.ignored);

    const overridden = ports.overridden(workspaceId);
    for (const [key, value] of Object.entries(wanted.settings)) {
        if (key in overridden) { out.kept.push(key); continue; }
        await ports.setSetting(workspaceId, key, value);
        out.applied.push(key);
    }

    if (wanted.defaultAgent !== null) {
        const agent = ports.agentsOf(workspaceId).find((a) => a.name.toLowerCase() === wanted.defaultAgent!.toLowerCase());
        if (ports.chosenDefaultAgentOf(workspaceId) !== null) out.kept.push('defaultAgent');
        else if (agent === undefined) out.waiting.push('defaultAgent');
        else { await ports.setDefaultAgent(workspaceId, agent.id); out.applied.push('defaultAgent'); }
    }

    if (wanted.envFile !== null) {
        if (envFileName(wanted.envFile) === null || wanted.envFile.includes('/') || wanted.envFile.includes('\\')) out.ignored.push('envFile');
        else {
            const recorded = ports.envFileOf(workspaceId);
            if (recorded === null || recorded === ports.defaultEnvFile()) { await ports.setEnvFile(workspaceId, wanted.envFile); out.applied.push('envFile'); }
            else out.kept.push('envFile');
        }
    }

    if (wanted.mcpOff !== null) {
        const off = new Set(ports.mcpOff(workspaceId));
        for (const name of wanted.mcpOff) {
            if (off.has(name)) { out.kept.push(`mcpOff:${name}`); continue; }
            await ports.setMcpServer(workspaceId, name, false);
            out.applied.push(`mcpOff:${name}`);
        }
    }
    return out;
}
