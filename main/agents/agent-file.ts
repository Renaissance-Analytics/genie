import { readFileSync } from 'node:fs';
import { relative as pathRelative } from 'node:path';
import { PROVIDER_IDS } from './registry';
import { agentMode, parseAgentMode, type AgentMode } from './agent-mode';

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
    /**
     * Automated or Manual (genie#408), or null when the file declares neither.
     *
     * NULL IS NOT `manual`, even though it RESOLVES to it. The distinction is
     * what keeps `renderAgentFile` from writing a `mode:` line into every
     * AGENT.md that never had one — which would be a diff on every agent and a
     * lit Save button on every one of them. Resolve it with `agentMode`.
     */
    mode: AgentMode | null;
}

/**
 * One frontmatter line Genie has no field for: `[key, rawValue]`.
 *
 * Kept because the file belongs to a HUMAN and is tracked in git. An editor over
 * this file (Tynn #709) saves by `parse → edit → render`, so every key the
 * renderer does not draw passes through here — and the original parser dropped
 * them, which meant opening an agent that carried `model:` or a teammate's
 * `description:` and pressing Save would delete those lines with no error and a
 * diff that looked deliberate.
 */
export type AgentFileExtra = [key: string, value: string];

export interface ParsedAgentFile {
    config: AgentFileConfig;
    /** The system prompt, VERBATIM. */
    body: string;
    /**
     * Header keys Genie has no field for, in file order.
     *
     * Pass them back to {@link renderAgentFile} to write them out again. An
     * editor may only change what it was asked to change; anything else is
     * carried, not judged.
     */
    extra: AgentFileExtra[];
}

/** The keys {@link renderAgentFile} emits itself. Anything else is passthrough —
 *  carrying a known key in `extra` too would write it twice. */
const KNOWN_KEYS = new Set(['name', 'purpose', 'scope', 'tuis', 'avatar', 'mode']);

const EMPTY: AgentFileConfig = {
    name: '',
    purpose: '',
    scope: null,
    tuis: [],
    avatar: null,
    mode: null,
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
    const extra: AgentFileExtra[] = [];
    for (const line of header) {
        const at = line.indexOf(':');
        // Not a key/value pair at all. Carrying it as one would write back
        // something that never parsed in the first place.
        if (at === -1) continue;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (!value) continue;
        if (!KNOWN_KEYS.has(key)) {
            extra.push([key, value]);
            continue;
        }
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
            case 'mode':
                // An unrecognised mode reads as UNDECLARED, which resolves to
                // Manual — the same treatment `tuis` gives a provider Genie
                // cannot launch, and for the same reason: a typo must not be
                // guessed into the one answer that tells an agent to act alone.
                config.mode = parseAgentMode(value);
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
    return { config, body, extra };
}

/**
 * Write an AGENT.md. Omits what is absent rather than emitting empty keys.
 *
 * `extra` is the passthrough bag from {@link parseAgentFile} — hand it back and
 * the keys Genie has no field for survive the write. It is OPTIONAL so the
 * registration path, which composes a brand-new file from nothing, keeps its
 * two-argument call.
 *
 * For a file in Genie's own key order this is a FIXED POINT: parse then render
 * reproduces it byte for byte, so opening an agent and pressing Save with no
 * edit produces no diff. A hand-written file that INTERLEAVES its own keys with
 * Genie's is rewritten into that order on first save — reordered, never lost,
 * which is the trade the alternative (tracking each key's original index) is not
 * worth.
 */
export function renderAgentFile(
    config: AgentFileConfig,
    body: string,
    extra: readonly AgentFileExtra[] = [],
): string {
    const header = [FENCE, `name: ${config.name}`, `purpose: ${config.purpose}`];
    // A blank `scope:` reads as "scoped to nothing"; ABSENCE reads as "the whole
    // workspace", which is the actual default. Same for the rest.
    if (config.scope) header.push(`scope: ${config.scope}`);
    if (config.tuis.length > 0) header.push(`tuis: [${config.tuis.join(', ')}]`);
    if (config.avatar) header.push(`avatar: ${config.avatar}`);
    // Absent means UNDECLARED, which reads as Manual. Emitting `mode: manual`
    // for every undeclared agent would put a line in every AGENT.md and light
    // Save on every one — so only a mode someone actually declared is written,
    // in EITHER direction: choosing Manual is a declaration, not a blank.
    if (config.mode) header.push(`mode: ${config.mode}`);
    for (const [key, value] of extra) {
        // A key Genie renders itself would be written twice. `parseAgentFile`
        // never puts one here; a hand-assembled `extra` might.
        if (KNOWN_KEYS.has(key)) continue;
        header.push(`${key}: ${value}`);
    }
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

/**
 * The mode an agent's own file declares, RESOLVED — Manual unless the file says
 * otherwise (genie#408).
 *
 * Reads the file for the same reason {@link agentAllowedTuis} does: the file is
 * the source of truth, and a human who edits `mode:` expects it to take effect
 * without a re-registration they have no reason to know about.
 *
 * Never throws. A missing or unreadable file reads as undeclared, which is
 * Manual — the direction that tells an agent to do LESS on its own.
 */
export function agentModeOf(personaPath: string | null | undefined): AgentMode {
    if (!personaPath) return agentMode(null);
    try {
        return agentMode(parseAgentFile(readFileSync(personaPath, 'utf8')).config.mode);
    } catch {
        return agentMode(null);
    }
}
