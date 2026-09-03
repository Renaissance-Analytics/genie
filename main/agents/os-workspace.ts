import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import { createAgiEnvelope } from '../workspace/create-agi';
import { osAgentBuilderSkill, writeWorkspaceAgentMcp } from '../mcp/agent-config';

/**
 * The workstation operator's envelope folder, in the user's HOME directory.
 *
 * It lived at `<userData>/genie-os.agi` — inside the one directory on the
 * machine whose entire purpose is to be deleted (Reset Workstation empties
 * `userData`, keeping only `PRESERVED_ENTRIES`). The operator's `.ai/memory` is
 * its accumulated knowledge of this workstation, and a reset it performed itself
 * would take it. `~/.gosa` sits outside that boundary, so a reset cannot reach it
 * at all — no preserve-list entry, no exception, nothing to remember.
 */
export const GOSA_FOLDER = '.gosa';

export function genieOsWorkspacePath(homeDir: string): string {
    return path.join(homeDir, GOSA_FOLDER);
}

/** Where the envelope used to live, so an existing install can be migrated. */
export function legacyGenieOsWorkspacePath(userDataDir: string): string {
    return path.join(userDataDir, 'genie-os.agi');
}

/** What a migration attempt did. `migrated` is false for "nothing to do" too —
 *  `reason` says which. */
export interface GenieOsMigration {
    migrated: boolean;
    /** The legacy folder, when there was one. */
    from: string | null;
    to: string;
    /** Files verified at the destination. */
    files: number;
    reason?: string;
}

/** Every file under `dir`, as paths relative to it. Directories are implied. */
function filesUnder(dir: string, base = dir): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...filesUnder(full, base));
        else if (entry.isFile()) out.push(path.relative(base, full));
    }
    return out;
}

/**
 * Prove the copy landed before anything starts using it.
 *
 * Size-equal for every file, and BYTE-equal for everything under `.ai/` — the
 * memory and knowledge are the part whose loss would be unacceptable, and a
 * matching size is not proof of matching content. Anything missing or different
 * fails the whole migration; a partial move is the failure mode that would be
 * discovered months later.
 */
function verifyCopy(source: string, destination: string): { ok: boolean; files: number; reason?: string } {
    const expected = filesUnder(source);
    for (const rel of expected) {
        const from = path.join(source, rel);
        const to = path.join(destination, rel);
        let toStat: fs.Stats;
        try {
            toStat = fs.statSync(to);
        } catch {
            return { ok: false, files: 0, reason: `missing at the destination: ${rel}` };
        }
        if (toStat.size !== fs.statSync(from).size) {
            return { ok: false, files: 0, reason: `size differs at the destination: ${rel}` };
        }
        const normalized = rel.split(path.sep).join('/');
        if (normalized.startsWith('.ai/') && !fs.readFileSync(from).equals(fs.readFileSync(to))) {
            return { ok: false, files: 0, reason: `content differs at the destination: ${rel}` };
        }
    }
    return { ok: true, files: expected.length };
}

/**
 * Move `<userData>/genie-os.agi` to `~/.gosa`, once, on an existing install.
 *
 * COPY, VERIFY, THEN SWAP — and the source is NEVER deleted. The old folder
 * holds the operator's memory and knowledge; there is no version of this worth
 * doing that risks it to save a directory's worth of disk. The copy lands in a
 * staging folder and is only renamed into place after every file is accounted
 * for, so a crash mid-copy leaves no half-envelope that would read as a good one.
 *
 * Idempotent by observation rather than by marker: a destination that already
 * holds a `project.json` is the operator's live envelope and is never touched
 * again — including one the user made themselves, which is why this refuses to
 * clobber rather than preferring the legacy copy.
 */
export function migrateLegacyGenieOsWorkspace(
    userDataDir: string,
    homeDir: string,
): GenieOsMigration {
    const legacy = legacyGenieOsWorkspacePath(userDataDir);
    const target = genieOsWorkspacePath(homeDir);
    const nothing = (reason: string, from: string | null = null): GenieOsMigration => ({
        migrated: false, from, to: target, files: 0, reason,
    });

    if (!fs.existsSync(path.join(legacy, 'project.json'))) {
        return nothing('no legacy envelope to migrate');
    }
    if (fs.existsSync(path.join(target, 'project.json'))) {
        return nothing('the operator already has an envelope at ~/.gosa', legacy);
    }

    const staging = `${target}.incoming`;
    try {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(legacy, staging, { recursive: true });
        const verified = verifyCopy(legacy, staging);
        if (!verified.ok) {
            fs.rmSync(staging, { recursive: true, force: true });
            return nothing(`copy could not be verified — ${verified.reason}`, legacy);
        }
        // A destination that exists without a `project.json` is the empty folder
        // `ensureGenieOsWorkspace` makes; anything else is somebody's data and is
        // left exactly where it is.
        if (fs.existsSync(target)) {
            if (fs.readdirSync(target).length > 0) {
                fs.rmSync(staging, { recursive: true, force: true });
                return nothing('~/.gosa already exists and is not empty', legacy);
            }
            fs.rmdirSync(target);
        }
        fs.renameSync(staging, target);
        return { migrated: true, from: legacy, to: target, files: verified.files };
    } catch (e) {
        fs.rmSync(staging, { recursive: true, force: true });
        return nothing(`migration failed — ${e instanceof Error ? e.message : String(e)}`, legacy);
    }
}

export interface GenieOsEntry {
    id: string;
    name: string;
    path: string;
    kind: 'file' | 'directory' | 'symlink';
}

export async function listGenieOsEntries(homeDir: string, relativePath: string): Promise<GenieOsEntry[]> {
    const root = await fs.promises.realpath(genieOsWorkspacePath(homeDir));
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

export async function syncGenieOsWorkspace(homeDir: string, remoteUrl: string): Promise<string> {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/i.test(remoteUrl)) {
        throw new Error('Genie OS sync requires a GitHub HTTPS clone URL.');
    }
    const { path: workspacePath } = await ensureGenieOsWorkspace(homeDir);
    const git = simpleGit(workspacePath);
    const remotes = await git.getRemotes(true);
    if (remotes.some((remote) => remote.name === 'origin')) await git.remote(['set-url', 'origin', remoteUrl]);
    else await git.addRemote('origin', remoteUrl);
    const { pushEnvelopeToOrigin } = await import('../workspace/create-agi');
    await pushEnvelopeToOrigin(workspacePath, 'main');
    return workspacePath;
}

/**
 * Ensure the built-in workstation operator has a durable, git-backed memory
 * envelope at `~/.gosa`, migrating an existing `<userData>/genie-os.agi` first.
 *
 * The migration runs BEFORE the create so an upgrading install never gets a
 * blank envelope written over the top of the one it already had. Its outcome is
 * returned rather than logged and forgotten — boot reports it, because a
 * migration that quietly did nothing is exactly the failure worth seeing.
 */
export async function ensureGenieOsWorkspace(
    homeDir: string,
    legacyUserDataDir?: string,
): Promise<{ path: string; migration: GenieOsMigration | null }> {
    const workspacePath = genieOsWorkspacePath(homeDir);
    const migration = legacyUserDataDir
        ? migrateLegacyGenieOsWorkspace(legacyUserDataDir, homeDir)
        : null;
    if (!fs.existsSync(path.join(workspacePath, 'project.json'))) {
        try {
            await createAgiEnvelope({
                slug: 'genie-os',
                name: 'Genie OS',
                parent_path: homeDir,
                // The folder is `.gosa`, not `<slug>.agi`: it is a fixed, protected
                // root the user never names, and a dotfolder keeps it out of the way
                // in a home directory it does not own.
                folder_name: GOSA_FOLDER,
                remote: { kind: 'none' },
            });
        } catch (e) {
            // `createAgiEnvelope` refuses a non-empty target, and this one lives
            // in the user's HOME — a folder they may have made themselves, or a
            // previous run may have half-written. That must not abort the boot:
            // an unguarded throw this early leaves Genie with no IPC and no
            // window (the shape of genie#349). Report it and carry on with the
            // folder as it stands; the operator still gets a working cwd below.
            console.warn(
                `[gosa] could not scaffold ${workspacePath} — ${e instanceof Error ? e.message : String(e)}`,
            );
        }
    }
    fs.mkdirSync(path.join(workspacePath, '.ai', 'memory'), { recursive: true });
    return { path: workspacePath, migration };
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
