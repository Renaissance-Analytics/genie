import { readFileSync } from 'node:fs';
import { relative as pathRelative } from 'node:path';
import { PROVIDER_IDS } from './registry';

/**
 * `.agents/<slug>/AGENT.md` — an agent's config AND its system prompt, in one
 * file the project commits.
 *
 * The path has existed since `registerAgent` shipped (`registration.ts` computes
 * it and stores it as `persona_path`) and nothing ever wrote it, so every
 * registered agent has booted with no persona at all.
 *
 * Config lives in frontmatter and the file is tracked in git, so an agent ships
 * WITH the project: a teammate cloning the repo gets the agents, and a change to
 * an agent's prompt is reviewable like any other change. That makes the FILE the
 * source of truth and the database a cache — which only works if a human editing
 * it by hand cannot break Genie. Hence: every field is optional, an unreadable
 * header never costs the prompt, and an unknown TUI is dropped rather than
 * carried to a launch that would fail far from the file that caused it.
 *
 * The shape mirrors the `SKILL.md` Genie already writes, so authoring an agent
 * and authoring a skill are one convention rather than two.
 *
 * Parsing and rendering are PURE — no fs, no electron — so the caller owns
 * reading and writing. `agentAllowedTuis` is the one exception, and reads the
 * file on purpose: the file is the source of truth, and a human who edits
 * `tuis:` expects it to take effect without a re-registration they have no
 * reason to know about.
 */

export interface AgentFileConfig {
    name: string;
    purpose: string;
    /** Workspace-relative folder the agent works in. null = the whole workspace. */
    scope: string | null;
    /** The TUIs this agent may run under; the first is its default driver. */
    tuis: string[];
    avatar: string | null;
}

export interface ParsedAgentFile {
    config: AgentFileConfig;
    /** The system prompt, VERBATIM. */
    body: string;
}

const EMPTY: AgentFileConfig = {
    name: '',
    purpose: '',
    scope: null,
    tuis: [],
    avatar: null,
};

const FENCE = '---';

/** Split the frontmatter block from the body, tolerating a file with neither. */
function split(raw: string): { header: string[]; body: string } {
    const text = raw.replace(/^﻿/, '');
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trim() !== FENCE) return { header: [], body: text };
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);
    // An unterminated header is a broken header, and the body is still the
    // author's prompt — treating the whole file as frontmatter would discard it.
    if (end === -1) return { header: [], body: text };
    return { header: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

function parseList(value: string): string[] {
    const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
    return inner
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/**
 * Read an AGENT.md. Never throws: a file a human owns must not be able to break
 * the app, and a header they mistyped must not cost them the prompt underneath.
 */
export function parseAgentFile(raw: string): ParsedAgentFile {
    const { header, body } = split(raw);
    const config: AgentFileConfig = { ...EMPTY, tuis: [] };
    for (const line of header) {
        const at = line.indexOf(':');
        if (at === -1) continue;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (!value) continue;
        switch (key) {
            case 'name':
                config.name = value;
                break;
            case 'purpose':
                config.purpose = value;
                break;
            case 'scope':
                config.scope = value;
                break;
            case 'avatar':
                config.avatar = value;
                break;
            case 'tuis':
                // Drop anything that is not a provider Genie can actually launch.
                // Carrying it would fail at start, far from the file at fault.
                config.tuis = parseList(value).filter((t) =>
                    (PROVIDER_IDS as readonly string[]).includes(t),
                );
                break;
            default:
                break;
        }
    }
    return { config, body };
}

/** Write an AGENT.md. Omits what is absent rather than emitting empty keys. */
export function renderAgentFile(config: AgentFileConfig, body: string): string {
    const header = [FENCE, `name: ${config.name}`, `purpose: ${config.purpose}`];
    // A blank `scope:` reads as "scoped to nothing"; ABSENCE reads as "the whole
    // workspace", which is the actual default. Same for the rest.
    if (config.scope) header.push(`scope: ${config.scope}`);
    if (config.tuis.length > 0) header.push(`tuis: [${config.tuis.join(', ')}]`);
    if (config.avatar) header.push(`avatar: ${config.avatar}`);
    header.push(FENCE, '');
    return `${header.join('\n')}\n${body.replace(/^\n+/, '')}`;
}

/**
 * The workspace-relative `scope` for a boot folder, or null for the root.
 *
 * Null rather than `'.'`: absence in the file means "the whole workspace", which
 * is the default, and writing `scope: .` would read as a deliberate narrowing
 * that isn't one. Always POSIX-separated, because the file is committed and read
 * on every platform.
 */
export function agentScopeFor(workspaceRoot: string, bootCwd: string): string | null {
    const rel = pathRelative(workspaceRoot, bootCwd);
    if (!rel || rel === '.') return null;
    return rel.split(/[\\/]/).join('/');
}

/**
 * The TUIs an agent's own file permits, or an empty list when it says nothing.
 *
 * Empty is "no opinion", not "none" — see {@link decideTuiSwitch}. Reads the
 * file rather than the database because the file is the source of truth, and a
 * human who edits `tuis:` expects that to take effect without a re-registration
 * they have no reason to know about.
 */
export function agentAllowedTuis(personaPath: string | null): string[] {
    if (!personaPath) return [];
    try {
        return parseAgentFile(readFileSync(personaPath, 'utf8')).config.tuis;
    } catch {
        // No file, or unreadable. "No opinion" is the safe reading: refusing
        // every switch because a file is missing would strand agents registered
        // before AGENT.md was written at all.
        return [];
    }
}
