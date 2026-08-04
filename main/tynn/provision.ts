import fs from 'fs';
import path from 'path';
import { TynnBackend } from '../backend/tynn';
import { getWorkspaceByPath } from '../db';
import {
    readProjectJson,
    writeProjectJson,
    type ProjectJsonTynn,
} from '../workspace/project-json';
import { readTynnLink, resolveTynnLinkForRow } from '../workspace/tynn-link';
import { hasTynnLiteralToken, writeWorkspaceTynnMcp } from '../mcp/agent-config';
import { isEnvelopeFolder } from '../workspace/envelope';

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

/** A minted MCP agent token + where to write it — the shape both mint auth
 *  sources produce (the cookie `TynnBackend.mintAgentToken` and the host-authed
 *  Workstation mint). Only `.mcp.json`-relevant fields; `scopes` is not needed. */
export interface TynnAgentTokenMint {
    token: string;
    mcpUrl: string;
    agent: { id: string; name: string };
    isOpsProject: boolean;
}

/**
 * The mint AUTH SOURCE for provisioning — the ONE seam that differs between the
 * desktop and the headless-host paths (genie #52). The desktop default rides the
 * user's Tynn web-session COOKIE; a Genie Cloud host injects a Workstation-signed
 * source so it provisions with its own enrolled identity (no cookie exists on a
 * headless host). The `.mcp.json` writer downstream is IDENTICAL either way —
 * only where the token comes from changes.
 */
export interface TynnProvisionAuth {
    /** Whether this source is authenticated enough to mint: a live cookie session
     *  (desktop) or a present enrolled Workstation identity (host). */
    ready(): Promise<boolean>;
    /**
     * Mint the project's MCP agent token, declaring whether the workspace being
     * linked is an `.agi` envelope (see {@link provisionWorkspaceTynn}).
     */
    mint(projectId: string, opts: TynnMintOptions): Promise<TynnAgentTokenMint>;
    /**
     * Declare an already-linked workspace an `.agi` envelope WITHOUT minting a
     * token (the self-heal for a workspace provisioned before the declaration
     * existed). Sticky server-side like the mint's flag — only ever sets true.
     * Optional: an auth source that predates it (or a test) simply skips the
     * self-heal.
     */
    declareEnvelope?(projectId: string): Promise<{ isEnvelope: boolean }>;
}

/**
 * What the link tells Tynn about the workspace behind it.
 *
 * Tynn gates IssueWatch — and the desktop's reconcile — on the project's
 * `is_envelope` flag, and nothing in this flow ever set it: the flag flipped
 * only when someone hand-tagged a repository `kind = envelope` in Tynn. A
 * workspace Genie had linked, provisioned and filled with repositories stayed a
 * plain Project forever, its feed dead with no signal on any surface
 * (tynn.ai#157).
 *
 * Genie is the only party that can answer this — Tynn deliberately does not read
 * project.json — so the mint carries the answer, exactly as the repo tag does.
 */
export interface TynnMintOptions {
    /** Whether the linked directory is a Genie `.agi` envelope workspace. */
    workspaceEnvelope: boolean;
}

/**
 * The default (desktop) mint auth: the user's Tynn web-session cookie via
 * `TynnBackend`. `ready` is the cookie `whoami`; `mint` is the cookie
 * `POST /api/v1/projects/agent-token`. The backend is injectable for tests.
 */
export function cookieProvisionAuth(
    backend: Pick<TynnBackend, 'whoami' | 'mintAgentToken' | 'declareEnvelope'> = new TynnBackend(),
): TynnProvisionAuth {
    return {
        ready: async () => !!(await backend.whoami()),
        mint: (projectId, opts) => backend.mintAgentToken(projectId, opts),
        declareEnvelope: (projectId) => backend.declareEnvelope(projectId),
    };
}

// `pickTynnLink` / `readTynnLink` now live in ../workspace/tynn-link so
// IssueWatch can resolve a workspace's Tynn project id without pulling in this
// module's graph (tynn.ai#134). Re-exported here — this is still their public
// import path.
export { pickTynnLink, readTynnLink } from '../workspace/tynn-link';

/**
 * A workspace's effective Tynn link, resolving project.json against the durable
 * workspace row (see `pickTynnLink`). This is the source of truth for status +
 * provisioning, so the link survives a project.json that never carried — or lost
 * — its `tynn` block.
 */
export function resolveTynnLink(workspacePath: string): ProjectJsonTynn | null {
    const ws = getWorkspaceByPath(workspacePath);
    return resolveTynnLinkForRow({
        backend: ws?.backend ?? '',
        path: workspacePath,
        tynn_project_id: ws?.tynn_project_id,
        tynn_project_name: ws?.tynn_project_name,
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
    opts: { force?: boolean; auth?: TynnProvisionAuth } = {},
): Promise<ProvisionResult> {
    const link = resolveTynnLink(workspacePath);
    // The mint AUTH SOURCE is the ONLY thing that differs desktop-vs-host: default
    // to the user cookie (desktop), or use an injected Workstation-signed source
    // (headless host, genie #52). Everything below is identical either way.
    const auth = opts.auth ?? cookieProvisionAuth();

    const signedIn = link ? await auth.ready() : false;
    const decision = decideProvision({
        linked: !!link,
        signedIn,
        alreadyConfigured: hasTynnLiteralToken(workspacePath),
        force: !!opts.force,
    });

    // SELF-HEAL the envelope flag on an already-provisioned `.agi` workspace.
    //
    // The mint below DECLARES the workspace an envelope, but it only runs on a
    // FRESH provision — so a workspace tokened before that declaration existed
    // never told Tynn it is an envelope, and Tynn gates IssueWatch on exactly
    // that flag (a dead feed with no signal, tynn.ai#157 follow-up). Declare it
    // out-of-band here — no new token, so no `.mcp.json`/`.env` churn and no
    // agent restart. Best-effort and idempotent (Tynn's flag is sticky-true);
    // gated on Genie's OWN envelope detector, never a bare project.json.
    if (decision === 'already' && signedIn && link?.projectId && isEnvelopeFolder(workspacePath)) {
        try {
            await auth.declareEnvelope?.(link.projectId);
        } catch {
            /* a failed self-heal must never break the open-workspace path */
        }
    }

    if (decision !== 'provision') return { status: decision };

    try {
        // DECLARE the envelope on every mint. The condition is Genie's OWN
        // envelope detector, not a new rule: a bare `project.json` proves nothing
        // (linkWorkspaceTynn writes one into ANY workspace it links), and
        // over-claiming is worse than the bug it fixes — Tynn then REQUIRES a
        // product repository_id on every new version for that project.
        const minted = await auth.mint(link!.projectId!, {
            workspaceEnvelope: isEnvelopeFolder(workspacePath),
        });
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
        // Don't return the raw exception text — this result is forwarded to the
        // (remote) mobile client (CodeQL js/stack-trace-exposure). Log it main-side;
        // return a generic message.
        console.error('[tynn/provision] provisioning failed:', e);
        return { status: 'error', error: 'provisioning failed' };
    }
}

/**
 * Read-only status for the UI: where this workspace stands without minting
 * anything. Returns the decision plus the resolved link (for display).
 */
export async function provisionStatus(
    workspacePath: string,
    auth?: TynnProvisionAuth,
): Promise<{
    status: ProvisionDecision;
    link: ProjectJsonTynn | null;
}> {
    const link = resolveTynnLink(workspacePath);
    // Same auth seam as provisioning (genie #52): default to the user cookie
    // (desktop), or use the injected Workstation-signed source (headless host —
    // no cookie exists, so the hardcoded whoami wrongly reported 'signed-out').
    const source = auth ?? cookieProvisionAuth();
    const signedIn = link ? await source.ready() : false;
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
    const needed = [
        '.mcp.json',
        '.cursor/',
        '.codex/config.toml',
        '.env',
        '.claude/settings.local.json',
    ];
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
