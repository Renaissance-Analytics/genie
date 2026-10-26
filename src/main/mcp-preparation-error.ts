const MESSAGES = {
    offline: 'Tynn could not be reached. Check your connection, then restart this agent. No shared workspace credential was used.',
    inactive: 'This Tynn agent or key is inactive. Review its status and renew its key in Tynn before restarting. No shared workspace credential was used.',
    conflict: 'This agent has a conflicting Tynn identity or project binding. Resolve it in Tynn, then restart. No shared workspace credential was used.',
    pending: 'A previous Tynn key request is unconfirmed. Review this agent’s keys in Tynn before trying again. No shared workspace credential was used.',
    storage: 'The private Tynn agent credential could not be unlocked or saved. Unlock OS credential encryption and check private storage, then restart. No shared workspace credential was used.',
    refused: 'Sign in to Tynn in Settings → Accounts and check this project’s agent access, then restart the agent. No shared workspace credential was used.',
    config: 'Tynn MCP config could not be reconciled. Check .mcp.json, .cursor/mcp.json and .codex/config.toml; remove or rename a conflicting custom tynn entry, then restart. No shared workspace credential was used.',
    workspace: 'This agent’s workspace or Tynn project link is unavailable or changed. Check the workspace, then restart. No shared workspace credential was used.',
    cancelled: 'Tynn agent credential preparation was cancelled.',
} as const;

/** Only these fixed, main-process failure codes may cross the preparation boundary. */
export class McpPreparationError extends Error {
    constructor(readonly code: keyof typeof MESSAGES) { super(MESSAGES[code]); }
}

export function mcpPreparationMessage(error: unknown): string {
    return error instanceof McpPreparationError && Object.hasOwn(MESSAGES, error.code) ? MESSAGES[error.code]
        : 'The agent could not prepare its private MCP connection. Restart to try again.';
}
