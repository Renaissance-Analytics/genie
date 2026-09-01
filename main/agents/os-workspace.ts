import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import { createAgiEnvelope } from '../workspace/create-agi';
import { osAgentBuilderSkill, writeWorkspaceAgentMcp } from '../mcp/agent-config';

export function genieOsWorkspacePath(userDataDir: string): string {
    return path.join(userDataDir, 'genie-os.agi');
}

export interface GenieOsEntry {
    id: string;
    name: string;
    path: string;
    kind: 'file' | 'directory' | 'symlink';
}

export async function listGenieOsEntries(userDataDir: string, relativePath: string): Promise<GenieOsEntry[]> {
    const root = await fs.promises.realpath(genieOsWorkspacePath(userDataDir));
    const target = await fs.promises.realpath(path.resolve(root, relativePath || '.'));
    const relativeTarget = path.relative(root, target);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
        throw new Error('Repository path escapes Genie OS workspace.');
    }
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    return entries
        .filter((entry) => entry.name !== '.git')
        .map((entry) => {
            const rel = path.relative(root, path.join(target, entry.name)).split(path.sep).join('/');
            const kind = entry.isSymbolicLink()
                ? 'symlink' as const
                : entry.isDirectory()
                    ? 'directory' as const
                    : 'file' as const;
            return { id: rel, name: entry.name, path: rel, kind };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function syncGenieOsWorkspace(userDataDir: string, remoteUrl: string): Promise<string> {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/i.test(remoteUrl)) {
        throw new Error('Genie OS sync requires a GitHub HTTPS clone URL.');
    }
    const workspacePath = await ensureGenieOsWorkspace(userDataDir);
    const git = simpleGit(workspacePath);
    const remotes = await git.getRemotes(true);
    if (remotes.some((remote) => remote.name === 'origin')) await git.remote(['set-url', 'origin', remoteUrl]);
    else await git.addRemote('origin', remoteUrl);
    const { pushEnvelopeToOrigin } = await import('../workspace/create-agi');
    await pushEnvelopeToOrigin(workspacePath, 'main');
    return workspacePath;
}

/** Ensure the built-in workstation operator has a durable, git-backed memory envelope. */
export async function ensureGenieOsWorkspace(userDataDir: string): Promise<string> {
    const workspacePath = genieOsWorkspacePath(userDataDir);
    if (!fs.existsSync(path.join(workspacePath, 'project.json'))) {
        await createAgiEnvelope({
            slug: 'genie-os',
            name: 'Genie OS',
            parent_path: userDataDir,
            remote: { kind: 'none' },
        });
    }
    fs.mkdirSync(path.join(workspacePath, '.ai', 'memory'), { recursive: true });
    return workspacePath;
}

/**
 * Give the Genie OS workspace the SAME wiring every other workspace gets.
 *
 * The workstation operator had none. `ensureGenieOsWorkspace` creates the
 * envelope and stops, and every `writeWorkspaceAgentMcp` call site is keyed on a
 * REGISTERED workspace row — which the OSA deliberately has not, so that
 * deleting a project can never delete or re-parent the operator. The result was
 * a folder with no `.mcp.json`, no `.agents/skills/`, and no Codex config.
 *
 * What that looked like on first boot: the OSA reported that
 * `manageWorkspaces`, `registerAgent`, `runAgent` and `manageTerminals` were not
 * in its toolset and that the `genie-agent-builder` skill it was being told to
 * act as did not exist. It was right on both counts. The agent responsible for
 * managing every workspace, onboarding, toolchain installs and upgrades booted
 * with none of the tools its own instructions named.
 *
 * A workspace-shaped folder needs workspace-shaped wiring, whether or not it has
 * a row in the database.
 */
export function wireGenieOsWorkspace(workspacePath: string, mcpUrl: string | null): boolean {
    // No endpoint means the MCP server has no port yet. Writing a config with a
    // null URL leaves a BROKEN `.mcp.json` on disk that looks configured, which
    // is worse than an absent one because nothing would retry it.
    //
    // genie#319 — that reasoning holds, but the early return had nothing
    // retrying it EITHER, and the call sat ~700 lines ahead of `startMcpServer`
    // in boot. `registerTerminalEndpoint` returns null until the server has a
    // port, so this fired on every boot of every machine and the OSA was left
    // with no `.mcp.json` and no `.agents/` — while the agent was still launched
    // with `--dangerously-load-development-channels server:genie-agentinbox-channel`,
    // which then could not resolve. Hence the boolean: a caller must be able to
    // tell "did nothing" from "wired", instead of reading void as success.
    if (!mcpUrl) return false;

    // `writeWorkspaceAgentMcp` returns early unless an agents doc already
    // exists — it deliberately does not litter one into projects that do not use
    // one. Silently doing nothing is exactly how this stayed broken, so the
    // precondition is guaranteed rather than assumed. An existing file is left
    // alone: it is the operator's own instructions and may have been edited.
    const agentsDoc = path.join(workspacePath, 'AGENTS.md');
    if (!fs.existsSync(agentsDoc)) {
        try {
            fs.writeFileSync(agentsDoc, '# Genie OS\n');
        } catch {
            return false; // nothing to sync into
        }
    }
    writeWorkspaceAgentMcp(workspacePath, true, mcpUrl);

    // The AgentBuilder skill is a FILE, not an opening prompt. It used to be
    // concatenated into `agent_instructions` and typed into the TUI on every
    // relaunch -- 1.2KB of SKILL.md, frontmatter and all, arriving repeatedly
    // with no task attached and describing a skill the agent could correctly
    // see it did not have. Installed, it loads when it is relevant, the way
    // every other skill works.
    //
    // Written HERE rather than added to `genieCoreSkills()` because it is
    // explicitly scoped to the workstation operator and has no business in a
    // project. Written for BOTH harness roots, because the operator has to work
    // whichever TUI the workstation defaults to.
    for (const root of ['.agents', '.claude']) {
        const dir = path.join(workspacePath, root, 'skills', 'genie-agent-builder');
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'SKILL.md'), osAgentBuilderSkill());
        } catch {
            /* best-effort: a missing skill degrades the operator, it does not
               stop it booting */
        }
    }
    return true;
}
