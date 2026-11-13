import { AGENT_NAME } from './agent-adoption.js';
import { formatLike } from './envelope-sites.js';
import { SCHEMA_REVISION, stampSchema } from './workspace-model.js';

/**
 * AN AGENT'S CONFIG LIVES IN project.json, ITS PERSONA IN AGENT.md (Tynn #694; the owner, 2026-11-13: "agent config should
 * be in the project.json, not in the AGENT.md file as frontmatter. This duplicates context and bloats the window.").
 *
 * - **Where it lives:** `agents.<name>` in the workspace's project.json — Civicognita/shared-schemas v0.4.0: a Genie agent
 *   name for the key, `{ purpose, provider?, tuis?, model? }` for the value and NOTHING else (no secret, no persona prose).
 *   Writing it stamps that revision; a manifest on a newer revision is never rewritten (stampSchema).
 * - **The persona:** `.agents/<name>/AGENT.md` is only the persona text. A new one is the purpose, said once.
 * - **The one-time move:** an AGENT.md that still opens with `---` front matter (written before #694) has it moved here the
 *   first time Genie reads its workspace (main/agent-config-host.ts), and stripped from the file. Forward-only: after that,
 *   front matter is never read — this module's parser exists for that move alone.
 */

export interface AgentConfig {
    readonly purpose: string;
    readonly provider?: string;
    readonly tuis?: readonly string[];
    readonly model?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** One line: every run of whitespace one space, the ends trimmed. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * One agent's config as the schema allows it, or `null`: only the four keys are carried (anything else — a credential, a
 * persona — is dropped, never written), and a malformed value is not guessed at.
 */
export function agentConfigOf(value: unknown): AgentConfig | null {
    if (!isRecord(value) || !nonEmpty(value.purpose)) return null;
    if (value.provider !== undefined && !nonEmpty(value.provider)) return null;
    if (value.model !== undefined && !nonEmpty(value.model)) return null;
    if (value.tuis !== undefined && (!Array.isArray(value.tuis) || !value.tuis.every(nonEmpty))) return null;
    return {
        purpose: value.purpose,
        ...(value.provider !== undefined ? { provider: value.provider as string } : {}),
        ...(value.tuis !== undefined ? { tuis: [...(value.tuis as string[])] } : {}),
        ...(value.model !== undefined ? { model: value.model as string } : {}),
    };
}

/** project.json's `agents`, every entry the schema allows; a malformed one (or name) is left out. */
export function agentConfigsOf(manifest: unknown): Record<string, AgentConfig> {
    if (!isRecord(manifest) || !isRecord(manifest.agents)) return {};
    const out: Record<string, AgentConfig> = {};
    for (const [name, value] of Object.entries(manifest.agents)) {
        if (!AGENT_NAME.test(name)) continue;
        const config = agentConfigOf(value);
        if (config) out[name] = config;
    }
    return out;
}

export type AgentConfigWrite =
    | { ok: true; text: string; changed: boolean; backup: { name: string; text: string } | null }
    | { ok: false; reason: string };

/**
 * project.json's text with `agents.<name>` set for each one given — Genie's writer: stamped with this Genie's schema
 * revision, in the file's own indentation and line endings, every other key (and every other agent) carried through.
 * `keepExisting`: an entry already there wins (the move never overrides what project.json says). Refuses — and so writes
 * nothing — for a missing or unreadable file, a manifest on a NEWER schema, a name Genie refuses, or a config the schema
 * does not allow. A backup only when an UNSTAMPED legacy file is first stamped (MIGRATIONS.md).
 */
export function agentConfigWrite(
    text: string | null,
    set: Readonly<Record<string, AgentConfig>>,
    options: { keepExisting?: boolean; revision?: string } = {},
): AgentConfigWrite {
    if (text === null) return { ok: false, reason: 'This workspace has no project.json, which is where an agent’s config is kept' };
    let manifest: unknown;
    try { manifest = JSON.parse(text); } catch { return { ok: false, reason: 'project.json is not valid JSON' }; }
    if (!isRecord(manifest)) return { ok: false, reason: 'project.json is not a JSON object' };
    const clean: Record<string, AgentConfig> = {};
    for (const [name, value] of Object.entries(set)) {
        if (!AGENT_NAME.test(name)) return { ok: false, reason: `"${name}" is not an agent name` };
        const config = agentConfigOf(value);
        if (!config) return { ok: false, reason: `${name} needs a purpose, and its provider, tuis and model must be non-empty text` };
        clean[name] = config;
    }
    const stamp = stampSchema(manifest, options.revision ?? SCHEMA_REVISION);
    if (!stamp.ok) return stamp;
    const existing = isRecord(manifest.agents) ? manifest.agents : {};
    const agents: Record<string, unknown> = { ...existing };
    let changed = false;
    for (const [name, config] of Object.entries(clean)) {
        if (options.keepExisting && name in existing) continue;
        if (JSON.stringify(existing[name]) === JSON.stringify(config)) continue;
        agents[name] = config;
        changed = true;
    }
    // Nothing to set: the file is not rewritten, and not restamped either.
    if (!changed) return { ok: true, text, changed: false, backup: null };
    const next = { ...stamp.manifest, agents };
    const backup = stamp.from === null && stamp.backup !== null ? { name: stamp.backup, text } : null;
    return { ok: true, text: formatLike(text, next), changed: true, backup };
}

/** A new agent's AGENT.md: the purpose, once, on one line. No front matter — the config is project.json's. */
export function agentPersonaText(purpose: string): string {
    return `${oneLine(purpose)}\n`;
}

/** What a pre-#694 AGENT.md's front matter becomes: its config, and the file's text without it. */
export interface FrontmatterMove {
    readonly config: AgentConfig;
    readonly persona: string;
}

const FRONT = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[^\S\r\n]*(?:\r?\n|$)/;

/** The front matter's own fields, in the two shapes Genie ever read (inline `[a, b]` and a dash list), no YAML library. */
function frontFields(block: string): { name?: string; purpose?: string; provider?: string; model?: string; tuis?: string[] } {
    const out: { name?: string; purpose?: string; provider?: string; model?: string; tuis?: string[] } = {};
    const lines = block.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const scalar = /^(name|purpose|provider|model):[^\S\r\n]*(.*?)\s*$/.exec(line);
        if (scalar) {
            const value = scalar[2]!.replace(/^(["'])(.*)\1$/, '$2');
            if (value !== '') out[scalar[1] as 'name' | 'purpose' | 'provider' | 'model'] = value;
            continue;
        }
        const inline = /^tuis:\s*\[(.*)\]\s*$/.exec(line);
        if (inline) {
            out.tuis = inline[1]!.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
            continue;
        }
        if (/^tuis:\s*$/.test(line)) {
            const tuis: string[] = [];
            while (i + 1 < lines.length && /^\s*-\s*/.test(lines[i + 1]!)) {
                i += 1;
                const t = lines[i]!.replace(/^\s*-\s*/, '').trim().toLowerCase();
                if (t !== '') tuis.push(t);
            }
            out.tuis = tuis;
        }
    }
    return out;
}

/**
 * The move of one AGENT.md, or `null` when it has no front matter (it is already only a persona). The config is the front
 * matter's `purpose`, `provider`, `tuis` and `model` — nothing else in it is carried. The persona is the rest of the file,
 * as written, with Genie's own duplicate dropped: a first line `You are <name>. <purpose>` becomes the purpose, said once.
 * No purpose in the front matter: the persona's first line of prose (its "You are <name>." dropped), else the name.
 */
export function frontmatterMove(text: string, name: string): FrontmatterMove | null {
    const m = FRONT.exec(text);
    if (!m) return null;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const fields = frontFields(m[1] ?? '');
    const body = text.slice(m[0].length).replace(/^(?:[^\S\r\n]*\r?\n)+/, '');
    const lines = body === '' ? [] : body.split(/\r?\n/);
    const you = new RegExp(`^You are ${name.replace(/[-]/g, '\\-')}\\.\\s*`);
    let purpose = fields.purpose !== undefined ? oneLine(fields.purpose) : '';
    if (purpose === '') {
        const first = lines.find((l) => l.trim() !== '' && !/^#/.test(l.trim()));
        purpose = first !== undefined ? oneLine(first.trim().replace(you, '')) : '';
        if (purpose === '') purpose = name;
    }
    let persona: string;
    if (lines.length === 0 || lines.every((l) => l.trim() === '')) {
        persona = `${purpose}${eol}`;
    } else {
        const first = lines[0]!;
        if (you.test(first.trim()) && oneLine(first.trim().replace(you, '')) === purpose) lines[0] = purpose;
        persona = lines.join(eol);
        if (!persona.endsWith(eol)) persona += eol;
    }
    const config: AgentConfig = {
        purpose,
        ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
        ...(fields.tuis !== undefined && fields.tuis.length > 0 ? { tuis: fields.tuis } : {}),
        ...(fields.model !== undefined ? { model: fields.model } : {}),
    };
    return { config, persona };
}
