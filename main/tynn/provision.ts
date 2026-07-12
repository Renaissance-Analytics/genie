import fs from 'fs';
import path from 'path';
import { TynnBackend } from '../backend/tynn';
import { getWorkspaceByPath } from '../db';
import {
    readProjectJson,
    writeProjectJson,
    type ProjectJsonTynn,
} from '../workspace/project-json';
import { hasTynnLiteralToken, writeWorkspaceTynnMcp } from '../mcp/agent-config';

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

/**
 * The link block AS STORED IN project.json — null unless it carries a
 * projectId. The narrow, file-only view; most callers want `resolveTynnLink`,
 * which also honours the durable workspace row.
 */
export function readTynnLink(workspacePath: string): ProjectJsonTynn | null {
    const pj = readProjectJson(workspacePath);
    const tynn = pj?.tynn;
    if (!tynn || !tynn.projectId) return null;
    return tynn;
}

/**
 * Pure: decide a workspace's effective Tynn link from its two possible homes.
 *
 * A Tynn link lives in TWO places: the secret-free `tynn` block in project.json
 * (written on link / provision) AND the durable `tynn_project_id` recorded on
 * the workspace row at creation. project.json is AUTHORITATIVE when it carries a
 * `tynn` key — *including an empty `{}`*, which is the deliberate "unlinked"
 * marker `unlinkWorkspaceTynn` writes, so an explicit unlink is never silently
 * re-linked from the row. Only when project.json has NO `tynn` key at all do we
 * fall back to the row, so a workspace that was associated with a Tynn project
 * but whose project.json never got (or lost) its `tynn` block is still
 * recognised as linked rather than reported 'unlinked'.
 */
export function pickTynnLink(input: {
    /** project.json's `tynn` value (may be {} for an explicit unlink). */
    projectJsonTynn: ProjectJsonTynn | undefined;
    /** Whether project.json carries a `tynn` key at all (vs the key absent). */
    hasTynnKey: boolean;
    /** The durable workspace row, if one matches this path. */
    row: {
        backend: string;
        tynnProjectId?: string | null;
        tynnProjectName?: string | null;
    } | null;
}): ProjectJsonTynn | null {
    if (input.hasTynnKey) {
        return input.projectJsonTynn?.projectId ? input.projectJsonTynn : null;
    }
    if (input.row && input.row.backend === 'tynn' && input.row.tynnProjectId) {
        return {
            projectId: input.row.tynnProjectId,
            project: input.row.tynnProjectName || undefined,
        };
    }
    return null;
}

/**
 * A workspace's effective Tynn link, resolving project.json against the durable
 * workspace row (see `pickTynnLink`). This is the source of truth for status +
 * provisioning, so the link survives a project.json that never carried — or lost
 * — its `tynn` block.
 */
export function resolveTynnLink(workspacePath: string): ProjectJsonTynn | null {
    const pj = readProjectJson(workspacePath);
    const ws = getWorkspaceByPath(workspacePath);
    return pickTynnLink({
        projectJsonTynn: pj?.tynn,
        hasTynnKey: !!pj && Object.prototype.hasOwnProperty.call(pj, 'tynn'),
        row: ws
            ? {
                  backend: ws.backend,
                  tynnProjectId: ws.tynn_project_id,
                  tynnProjectName: ws.tynn_project_name,
              }
            : null,
    });
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
    const link = resolveTynnLink(workspacePath);
    const backend = new TynnBackend();

    const signedIn = link ? !!(await backend.whoami()) : false;
    const decision = decideProvision({
        linked: !!link,
        signedIn,
        alreadyConfigured: hasTynnLiteralToken(workspacePath),
        force: !!opts.force,
    });

    if (decision !== 'provision') return { status: decision };

    try {
        const minted = await backend.mintAgentToken(link!.projectId!);
        // Self-heal: when the link was recovered from the durable workspace row
        // (project.json carried no `tynn` block), write it back so project.json
        // and the row agree and the AGI gateway sees the mapping too.
        if (!readTynnLink(workspacePath)) {
            try {
                linkWorkspaceTynn(workspacePath, link!);
            } catch {
                /* best-effort — provisioning must not fail on a self-heal write */
            }
        }
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
    const link = resolveTynnLink(workspacePath);
    const signedIn = link ? !!(await new TynnBackend().whoami()) : false;
    return {
        status: decideProvision({
            linked: !!link,
            signedIn,
            alreadyConfigured: hasTynnLiteralToken(workspacePath),
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
 * Clear a workspace's Tynn project link. Writes an EXPLICIT empty `tynn: {}`
 * block (not a delete): the empty-but-present block is the deliberate "unlinked"
 * marker `resolveTynnLink` honours, so the unlink sticks instead of being
 * silently re-linked from the durable workspace row on the next open. We rewrite
 * the whole file because writeProjectJson MERGES the tynn block (so it can't
 * empty it). The provisioned `.mcp.json` token is left as-is — clearing the link
 * just stops auto-provision and lets the user pick a different project; the next
 * provision is a no-op ('unlinked') until they re-link.
 */
export function unlinkWorkspaceTynn(workspacePath: string): void {
    const pj = readProjectJson(workspacePath) ?? {};
    pj.tynn = {};
    const file = path.join(workspacePath, 'project.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(pj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

/**
 * Make sure `.mcp.json` (which carries the bearer token) and `.cursor/` can't
 * be committed. Appends the entries to the workspace `.gitignore` when absent.
 * Best-effort — a missing/locked .gitignore must not break provisioning.
 */
export function ensureMcpGitignored(workspacePath: string): void {
    const file = path.join(workspacePath, '.gitignore');
    // `.env` now carries the Tynn agent token (the `.mcp.json` entry only refs
    // it); `.mcp.json` + `.cursor/` stay listed too. `.claude/settings.local.json`
    // carries the per-machine `enableAllProjectMcpServers` approval (genie #10) —
    // machine-local like the provisioned `.mcp.json` it enables, so never commit it.
    const needed = ['.mcp.json', '.cursor/', '.env', '.claude/settings.local.json'];
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
