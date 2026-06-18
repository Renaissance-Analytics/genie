import fs from 'fs';
import path from 'path';
import { TynnBackend } from '../backend/tynn';
import {
    readProjectJson,
    writeProjectJson,
    type ProjectJsonTynn,
} from '../workspace/project-json';
import { hasTynnServer, writeWorkspaceTynnMcp } from '../mcp/agent-config';

/**
 * Auto-provision the Tynn MCP agent token + Agent config for a workspace.
 *
 * Genie holds the user's Tynn web session (the genie:// handoff). When a
 * workspace's project.json carries a `tynn` link block and the user is signed
 * in, Genie mints an MCP agent token via /api/v1/projects/agent-token and
 * writes the workspace `.mcp.json` `tynn` server so any agent in that workspace
 * can talk to Tynn — no manual copy-paste.
 *
 * The token is a secret: it only ever lands in `.mcp.json` (gitignored — the
 * provisioner enforces that), never in project.json.
 */

export type ProvisionDecision = 'unlinked' | 'signed-out' | 'already' | 'provision';

/**
 * Pure: decide what to do, given the workspace's link state + session +
 * whether a tynn server is already written. Kept separate from IO so the
 * gating rules are unit-testable.
 */
export function decideProvision(input: {
    linked: boolean;
    signedIn: boolean;
    alreadyConfigured: boolean;
    force: boolean;
}): ProvisionDecision {
    if (!input.linked) return 'unlinked';
    if (!input.signedIn) return 'signed-out';
    if (input.alreadyConfigured && !input.force) return 'already';
    return 'provision';
}

export interface ProvisionResult {
    status: ProvisionDecision | 'error';
    /** Present on a successful provision. */
    agent?: { id: string; name: string };
    isOpsProject?: boolean;
    error?: string;
}

/** The link block, if this workspace points at a Tynn project. */
export function readTynnLink(workspacePath: string): ProjectJsonTynn | null {
    const pj = readProjectJson(workspacePath);
    const tynn = pj?.tynn;
    if (!tynn || !tynn.projectId) return null;
    return tynn;
}

/**
 * Provision (or refresh) the workspace's Tynn agent token + Agent config.
 * Best-effort and idempotent: a workspace that isn't linked, a signed-out
 * user, or an already-configured workspace (without `force`) is a no-op with a
 * descriptive status — never throws into the open-workspace path.
 */
export async function provisionWorkspaceTynn(
    workspacePath: string,
    opts: { force?: boolean } = {},
): Promise<ProvisionResult> {
    const link = readTynnLink(workspacePath);
    const backend = new TynnBackend();

    const signedIn = link ? !!(await backend.whoami()) : false;
    const decision = decideProvision({
        linked: !!link,
        signedIn,
        alreadyConfigured: hasTynnServer(workspacePath),
        force: !!opts.force,
    });

    if (decision !== 'provision') return { status: decision };

    try {
        const minted = await backend.mintAgentToken(link!.projectId!);
        ensureMcpGitignored(workspacePath);
        writeWorkspaceTynnMcp(workspacePath, true, {
            url: minted.mcpUrl,
            token: minted.token,
        });
        return {
            status: 'provision',
            agent: minted.agent,
            isOpsProject: minted.isOpsProject,
        };
    } catch (e) {
        return { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Read-only status for the UI: where this workspace stands without minting
 * anything. Returns the decision plus the resolved link (for display).
 */
export async function provisionStatus(workspacePath: string): Promise<{
    status: ProvisionDecision;
    link: ProjectJsonTynn | null;
}> {
    const link = readTynnLink(workspacePath);
    const signedIn = link ? !!(await new TynnBackend().whoami()) : false;
    return {
        status: decideProvision({
            linked: !!link,
            signedIn,
            alreadyConfigured: hasTynnServer(workspacePath),
            force: false,
        }),
        link,
    };
}

/**
 * Link a workspace to a Tynn project by writing the (secret-free) `tynn` block
 * into project.json. Provisioning reads it on the next open / explicit call.
 */
export function linkWorkspaceTynn(workspacePath: string, link: ProjectJsonTynn): void {
    writeProjectJson(workspacePath, { tynn: link });
}

/**
 * Make sure `.mcp.json` (which carries the bearer token) and `.cursor/` can't
 * be committed. Appends the entries to the workspace `.gitignore` when absent.
 * Best-effort — a missing/locked .gitignore must not break provisioning.
 */
export function ensureMcpGitignored(workspacePath: string): void {
    const file = path.join(workspacePath, '.gitignore');
    const needed = ['.mcp.json', '.cursor/'];
    try {
        let content = '';
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch {
            /* no .gitignore yet — we'll create one */
        }
        const lines = content.split(/\r?\n/).map((l) => l.trim());
        const missing = needed.filter((n) => !lines.includes(n) && !lines.includes(n.replace(/\/$/, '')));
        if (missing.length === 0) return;
        const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
        const block = `${prefix}\n# Genie: MCP config carries a Tynn bearer token — never commit it.\n${missing.join('\n')}\n`;
        fs.writeFileSync(file, content + block);
    } catch {
        /* best-effort */
    }
}
