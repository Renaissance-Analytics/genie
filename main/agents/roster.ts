import { agentName } from './identity';
import { parseAgentFile, type AgentFileConfig } from './agent-file';
import { reservedNameRefusal } from './reserved-names';
import { isTuiId } from './registry';

/**
 * PURE (+ one injected fs seam). The READER for `.agents/<slug>/AGENT.md`.
 *
 * ## The half that was never built
 *
 * `deletion.ts` states the design outright:
 *
 * > UNMOUNT never removes a file — keeping every `.agents/*` file is the entire
 * > point.
 *
 * The keeping worked. The coming back did not exist: **nothing in Genie ever
 * read that directory.** So an agent's durable half survived every unmount, and
 * no surface could turn it back into an agent (genie#465). Three of the owner's
 * agents were sitting on disk with no row when this was written — `trader`,
 * `ripple` and `twenty`.
 *
 * ## Three ways a file ends up with no row, not two
 *
 * The issue named two: an UNLINKED workspace gets a fresh id when it is re-added
 * (`add-workspace.ts` — `id: projectId || plan.unlinkedId`), so its agents
 * orphan on the same machine; and `workspace_agents` lives only in the local
 * `genie.db`, so a project opened on ANOTHER machine has no agents at all even
 * though its files travelled with the repo.
 *
 * There is a third, and two of those three orphans are it: **the file was
 * written by a HUMAN and never registered.** Registration always renders
 * frontmatter (`renderAgentFile`), and `trader` and `ripple` have none — they
 * are hand-authored personas, deliverables of the GApps they live in. Which is
 * why {@link adoptionRequest} must cope with a file that declares nothing at
 * all: the files this exists to recover are exactly the ones Genie did not write.
 *
 * ## Offering is the design
 *
 * This module lists. It never registers. Silently adopting whatever is on disk
 * would turn `git pull` into a way to gain agents, and a workspace's roster into
 * something the repo decides.
 */

/** The filesystem seam. Total: an unreadable path is an empty answer. */
export interface AgentFilesFs {
    /** Subdirectory names directly inside `dir`; `[]` when it does not exist. */
    listDirs(dir: string): string[];
    /** File contents, or null when it is absent or unreadable. */
    readFile(path: string): string | null;
}

/** One `.agents/<folder>/AGENT.md` on disk. */
export interface AgentFileOnDisk {
    /**
     * The FOLDER name, which is the agent's identity on disk.
     *
     * Not the frontmatter `name:`. The path is what registration commits to —
     * `resolveAgentRegistration` builds `.agents/<agentName(name)>/AGENT.md` —
     * so adopting under a name that disagrees with the folder would write a
     * SECOND folder and leave this one orphaned exactly as it was.
     */
    folder: string;
    personaPath: string;
    /** The file, verbatim. Kept because a file with no frontmatter still has an
     *  author's heading in it, and that is the only purpose it states. */
    raw: string;
    config: AgentFileConfig;
}

/** The registry's side of the diff — what `workspace_agents` holds. */
export interface RegisteredAgentSummary {
    id: string;
    name: string;
    purpose: string;
    role: string;
    tui: string;
    /** Whether any terminal this agent could be running under is alive. */
    running: boolean;
}

/** One line of the roster: an agent, and which halves of it exist. */
export interface RosterEntry {
    name: string;
    /** There is a row in `workspace_agents`. */
    registered: boolean;
    /** There is an `AGENT.md`. Both false is impossible; either alone is the
     *  interesting case, and each has a different remedy. */
    onDisk: boolean;
    agentId?: string;
    purpose: string;
    tuis: string[];
    scope: string | null;
    personaPath?: string;
    role?: string;
    /** The driver the registry has this agent on. Registered rows only. */
    tui?: string;
    /**
     * Whether this agent is UP — genie#474.
     *
     * Always false for an unregistered file: there is no process behind an
     * `AGENT.md` the registry has never heard of, and a row that claimed
     * otherwise would draw a Stop button over nothing.
     */
    running: boolean;
    /**
     * Why this file will NOT be offered for adoption.
     *
     * Present only on an unregistered entry, and only when there is a real
     * reason — a reserved name, or a folder registration could not reuse. An
     * Adopt button that always fails is worse than none; the same rule the
     * agent-CLI catalog holds itself to.
     */
    refusal?: string;
}

/** `<root>/.agents`, in the platform-neutral form the seam is given. */
function agentsDir(workspaceRoot: string): string {
    return `${workspaceRoot.replace(/[\\/]+$/, '')}/.agents`;
}

/**
 * Every agent file under a workspace's `.agents/`.
 *
 * A folder counts ONLY when it holds an `AGENT.md`. `.agents/` is not only
 * agents: this envelope's own copy carries `_genie/` (shared instructions) and
 * `skills/` (SKILL.md files) beside `tynn/`, and a scan that took every
 * subdirectory would offer to adopt both of them.
 *
 * Never throws — a workspace whose folder has been moved or unmounted is the
 * ordinary case for this feature, not an error.
 */
export function agentFilesIn(workspaceRoot: string, fs: AgentFilesFs): AgentFileOnDisk[] {
    const dir = agentsDir(workspaceRoot);
    let folders: string[];
    try {
        folders = fs.listDirs(dir);
    } catch {
        return [];
    }
    const out: AgentFileOnDisk[] = [];
    for (const folder of [...folders].sort()) {
        const personaPath = `${dir}/${folder}/AGENT.md`;
        let raw: string | null;
        try {
            raw = fs.readFile(personaPath);
        } catch {
            raw = null;
        }
        if (raw === null) continue;
        out.push({ folder, personaPath, raw, config: parseAgentFile(raw).config });
    }
    return out;
}

/** Why this on-disk folder cannot be adopted as it stands, or null. */
function adoptionRefusal(folder: string, sacredName?: string | null): string | null {
    const slug = agentName(folder);
    if (slug !== folder) {
        return (
            `The folder \`.agents/${folder}\` is not a name Genie can register — it would ` +
            `create \`.agents/${slug}\` instead and leave this one behind. Rename the folder ` +
            `to \`${slug}\` and it can be adopted.`
        );
    }
    return reservedNameRefusal({ name: slug, ...(sacredName ? { sacredName } : {}) });
}

export interface WorkspaceRosterInput {
    registered: RegisteredAgentSummary[];
    files: AgentFileOnDisk[];
    /** `workspaces.sacred_name` — the ONE reserved term this workspace may use. */
    sacredName?: string | null;
}

/**
 * The roster: every registered agent, then every file the registry has never
 * heard of.
 *
 * Registered first and IN THE ORDER GIVEN — `listWorkspaceAgents` already sorts
 * the workspace agent to the top, and re-sorting here would put the roster and
 * the grid in different orders for no reason. The adoptable ones follow,
 * alphabetically, because nothing has ranked them.
 *
 * Matched by NAME, which is what `workspace_agents` is unique on since v55 and
 * what `getWorkspaceAgentByName` looks up. Matching on the driver too is how a
 * name could hold two agents.
 */
export function workspaceRoster(input: WorkspaceRosterInput): RosterEntry[] {
    const byFolder = new Map(input.files.map((f) => [f.folder, f]));
    const seen = new Set<string>();

    const registered: RosterEntry[] = input.registered.map((row) => {
        seen.add(row.name);
        const file = byFolder.get(row.name);
        return {
            name: row.name,
            registered: true,
            onDisk: file !== undefined,
            agentId: row.id,
            // The FILE wins where it speaks: it is the source of truth and the
            // row is its cache, so a hand-edited purpose shows here rather than
            // whatever was typed at registration.
            purpose: file?.config.purpose || row.purpose,
            tuis: file?.config.tuis ?? [],
            scope: file?.config.scope ?? null,
            role: row.role,
            tui: row.tui,
            running: row.running,
            ...(file ? { personaPath: file.personaPath } : {}),
        };
    });

    const adoptable: RosterEntry[] = input.files
        .filter((f) => !seen.has(f.folder))
        .sort((a, b) => a.folder.localeCompare(b.folder))
        .map((file) => {
            const refusal = adoptionRefusal(file.folder, input.sacredName);
            return {
                name: file.folder,
                registered: false,
                onDisk: true,
                purpose: purposeFromFile(file),
                tuis: file.config.tuis,
                scope: file.config.scope,
                personaPath: file.personaPath,
                // Nothing is running behind a file with no row.
                running: false,
                ...(refusal ? { refusal } : {}),
            };
        });

    return [...registered, ...adoptable];
}

/** The entries an Adopt button may be offered for. */
export function adoptableAgents(roster: RosterEntry[]): RosterEntry[] {
    return roster.filter((e) => !e.registered && e.onDisk && !e.refusal);
}

/**
 * What this agent is FOR, in the file's own words.
 *
 * `resolveAgentRegistration` refuses an empty purpose, and two of the three
 * files this feature exists to recover state none — they were written by hand
 * and have no frontmatter at all. So there is a fallback, and it is the file's
 * own H1 rather than a sentence Genie made up: "Ripple — the director" is the
 * author saying what the agent is, and an invented purpose would be Genie
 * claiming it.
 *
 * With neither, the honest answer is where the file came from. That is a fact
 * about provenance, not a claim about the agent.
 */
export function purposeFromFile(file: AgentFileOnDisk): string {
    const stated = file.config.purpose.trim();
    if (stated) return stated;
    for (const line of file.raw.split(/\r?\n/)) {
        const heading = /^#{1,3}\s+(.*\S)\s*$/.exec(line);
        if (heading) return heading[1]!;
    }
    return `Adopted from .agents/${file.folder}/AGENT.md, which states no purpose.`;
}

/** The registration `agents:create` / `registerAgent` takes, built from a file. */
export interface AdoptionRequest {
    name: string;
    purpose: string;
    /** The driver the file names first, when the registry knows it. */
    agent?: string;
    /** The file's `scope:`, as a workspace-relative boot folder. */
    bootFolder?: string;
}

/**
 * A file, as a registration.
 *
 * PURE, and deliberately only a REQUEST: it is handed to the same
 * `registerAgentInWorkspace` the MCP tool and the create form use, so adoption
 * cannot become a second way past the name checks, the reserved list, or the
 * rule that the persona file is never overwritten.
 *
 * An unknown `tuis:` entry is DROPPED rather than passed on. A driver the
 * registry has never heard of would fail at launch, far from the file that
 * named it; falling back to the workstation default is the same treatment
 * `agentAllowedTuis` already gives it.
 */
export function adoptionRequest(file: AgentFileOnDisk): AdoptionRequest {
    const tui = file.config.tuis.find((t) => isTuiId(t));
    const scope = file.config.scope?.trim();
    return {
        name: file.folder,
        purpose: purposeFromFile(file),
        ...(tui ? { agent: tui } : {}),
        ...(scope ? { bootFolder: scope } : {}),
    };
}
