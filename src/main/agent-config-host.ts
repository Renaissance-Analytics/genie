import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_NAME } from '../core/agent-adoption.js';
import { renameOver } from '../core/atomic-rename.js';
import { agentConfigWrite, frontmatterMove, type AgentConfig } from '../core/agent-config.js';

/**
 * THE ONE-TIME MOVE OF AGENT.md FRONT MATTER INTO project.json (Tynn #694) — the host half of core/agent-config.ts.
 *
 * Before #694 Genie wrote an agent's config as front matter in `.agents/<name>/AGENT.md` (`name`, `purpose`, `tuis`), and
 * the agent loaded it with its persona — the purpose twice. Now the config is `agents.<name>` in project.json. The first
 * time Genie reads a workspace (its estate pass, listing its agents to adopt, creating one), every AGENT.md that still
 * opens with front matter is moved:
 *
 * 1. Every move is worked out first; nothing is written if project.json cannot take the config (none, not JSON, a newer
 *    schema): the front matter stays rather than being lost.
 * 2. project.json is written ONCE, atomically (temp + rename), every other key and agent kept; an entry already there wins.
 * 3. Only then is each AGENT.md rewritten without its front matter — a failure between 2 and 3 leaves the config in both
 *    places, never in neither, and the next read finishes the move (the entry in project.json still wins).
 *
 * Forward-only (the owner): after the move the front matter is never read again.
 */

export interface AgentConfigFs {
    /** The folders directly under `dir`; rejects when it does not exist. */
    listDirs(dir: string): Promise<readonly string[]>;
    /** A file's text, or `null` when there is none. */
    readText(path: string): Promise<string | null>;
    /** Replace the file whole (temp + rename). */
    writeTextAtomic(path: string, text: string): Promise<void>;
}

let tmpCounter = 0;

/** The real filesystem: folders by `readdir`, a missing file `null`, and every write a temp file renamed over the target. */
export function nodeAgentConfigFs(): AgentConfigFs {
    return {
        listDirs: async (dir) => (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name),
        readText: async (path) => {
            try {
                return await readFile(path, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        },
        writeTextAtomic: async (path, text) => {
            const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
            await writeFile(tmp, text, 'utf8');
            await renameOver(tmp, path);
        },
    };
}

export type MoveResult = { ok: true; moved: string[] } | { ok: false; reason: string };

/** Moves in flight, by workspace folder: two reads at once move once. */
const inFlight = new Map<string, Promise<MoveResult>>();

export function moveAgentFrontmatter(fs: AgentConfigFs, workspacePath: string): Promise<MoveResult> {
    const running = inFlight.get(workspacePath);
    if (running) return running;
    const run = move(fs, workspacePath).finally(() => inFlight.delete(workspacePath));
    inFlight.set(workspacePath, run);
    return run;
}

async function move(fs: AgentConfigFs, workspacePath: string): Promise<MoveResult> {
    const dir = join(workspacePath, '.agents');
    let folders: readonly string[];
    try {
        folders = await fs.listDirs(dir);
    } catch {
        return { ok: true, moved: [] };
    }
    const moves: Array<{ name: string; file: string; persona: string; config: AgentConfig }> = [];
    for (const name of [...folders].sort()) {
        // Only an agent name Genie takes: `_genie/`, `skills/` and a folder adoption would refuse are not touched.
        if (!AGENT_NAME.test(name)) continue;
        const file = join(dir, name, 'AGENT.md');
        const text = await fs.readText(file);
        if (text === null) continue;
        const m = frontmatterMove(text, name);
        if (m) moves.push({ name, file, ...m });
    }
    if (moves.length === 0) return { ok: true, moved: [] };

    const manifestPath = join(workspacePath, 'project.json');
    const write = agentConfigWrite(await fs.readText(manifestPath), Object.fromEntries(moves.map((m) => [m.name, m.config])), { keepExisting: true });
    if (!write.ok) return { ok: false, reason: `the agents' front matter was not moved: ${write.reason}` };
    if (write.changed) {
        if (write.backup) await fs.writeTextAtomic(join(workspacePath, write.backup.name), write.backup.text);
        await fs.writeTextAtomic(manifestPath, write.text);
    }
    for (const m of moves) await fs.writeTextAtomic(m.file, m.persona);
    return { ok: true, moved: moves.map((m) => m.name) };
}
