import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * OMARCHY'S AGENT SKILLS, READ FROM THE SYSTEM (the owner, 2026-10-19: genie gets everything Omarchy provides for agents).
 * Omarchy 4 installs them in /usr/share/omarchy/default/agents/skills/<name>/ (measured on omarchy-test: `omarchy`,
 * `diagnose-crash`) and symlinks them into ~/.claude/skills, ~/.agents/skills and ~/.codex/skills. Each folder with a
 * SKILL.md is a skill; every text file under it is read, so a skill's references come with it.
 *
 * `null` when the folder is not there (not an Omarchy host) — never `{}`, which would claim Omarchy with no skills.
 */
export const OMARCHY_SKILLS_DIR = '/usr/share/omarchy/default/agents/skills';

/** A skill file bigger than this is not copied (skills are prose; a binary does not belong in an agent's home). */
const MAX_FILE_BYTES = 256 * 1024;

async function filesUnder(root: string, rel = ''): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const full = join(root, childRel);
        // Follow a symlinked file or folder as Omarchy itself would be read.
        const info = entry.isSymbolicLink() ? await stat(full) : entry;
        if (info.isDirectory()) Object.assign(out, await filesUnder(root, childRel));
        else if (info.isFile() && (await stat(full)).size <= MAX_FILE_BYTES) out[childRel] = await readFile(full, 'utf8');
    }
    return out;
}

export async function readOmarchySkills(dir: string = OMARCHY_SKILLS_DIR): Promise<Record<string, Record<string, string>> | null> {
    let names: string[];
    try {
        names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
    } catch {
        return null;
    }
    const skills: Record<string, Record<string, string>> = {};
    for (const name of names.sort()) {
        try {
            const files = await filesUnder(join(dir, name));
            if (files['SKILL.md'] !== undefined) skills[name] = files;
        } catch {
            // An unreadable skill is skipped; the others still reach genie.
        }
    }
    return skills;
}

/** genie's facts about Omarchy: its skills on an Omarchy host (Linux, the folder present, at least one skill), else `null`. */
export async function omarchyFacts(platform: string = process.platform): Promise<{ skills: Record<string, Record<string, string>> } | null> {
    if (platform !== 'linux') return null;
    const skills = await readOmarchySkills();
    return skills && Object.keys(skills).length > 0 ? { skills } : null;
}
