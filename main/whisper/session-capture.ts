import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { WhisperAgentType } from './types';

/**
 * Capture an AI TUI's CHAT-SESSION identity when Genie launches it, so a
 * specialized terminal can be tied back to its conversation (surfaced on the
 * agent list + whisper).
 *
 * Two strategies, per a small per-agent PROFILE:
 *   - `flag`   — the CLI accepts a session-id flag on launch. We MINT a uuid and
 *                append the flag (unless the user's command already set one), so
 *                the id is known immediately. Claude Code supports
 *                `--session-id <uuid>` (confirmed at build time: `claude --help`).
 *   - `detect` — no launch flag; after launch we briefly watch the transcript dir
 *                for the newest new `*.jsonl` (its filename stem IS the session id).
 *   - `none`   — no capture (e.g. codex in v1).
 *
 * The pure pieces (profile lookup, flag render, dir encoding, filename parse,
 * newest-pick) are unit-tested; only the watcher touches fs.
 */

export type SessionStrategy = 'flag' | 'detect' | 'none';

interface LaunchProfile {
    strategy: SessionStrategy;
    /** For `flag`: the flag template, `{id}` substituted with the minted uuid. */
    flagTemplate?: string;
}

/** Per-agent launch profiles. `claude` uses the confirmed `--session-id` flag;
 *  `custom` best-effort DETECTs from the Claude transcript dir (a custom command
 *  is often a claude wrapper); `codex` has no capture in v1. */
export const LAUNCH_PROFILES: Record<WhisperAgentType, LaunchProfile> = {
    claude: { strategy: 'flag', flagTemplate: '--session-id {id}' },
    codex: { strategy: 'none' },
    custom: { strategy: 'detect' },
};

/** A launch already carries a session id / is resuming — don't inject a flag. */
const SESSION_FLAG_RE = /(^|\s)--session-id(=|\s)/;
const RESUME_FLAG_RE = /(^|\s)(--resume|--continue|-r|-c)(=|\s|$)/;

/** Extract the uuid from an existing `--session-id <uuid>`/`=uuid`, or null. */
export function extractSessionId(command: string): string | null {
    const m = String(command ?? '').match(
        /--session-id(?:=|\s+)([0-9a-fA-F-]{8,})/,
    );
    return m ? m[1] : null;
}

export interface RenderedLaunch {
    /** The command to actually submit (augmented for `flag` when applicable). */
    command: string;
    /** The captured/known session id, or null (detect resolves it later). */
    chatSessionId: string | null;
    strategy: SessionStrategy;
}

/**
 * Render the launch command for an agent, applying its session-capture profile.
 * IDEMPOTENT: a command that already sets `--session-id` (or is resuming) is left
 * untouched — we reuse/extract its id rather than append a second flag. `genId`
 * is injectable for tests (defaults to a real uuid).
 */
export function renderAgentLaunch(
    agent: WhisperAgentType,
    command: string,
    genId: () => string = () => crypto.randomUUID(),
): RenderedLaunch {
    const profile = LAUNCH_PROFILES[agent] ?? { strategy: 'none' as const };
    const cmd = String(command ?? '');

    // Already resuming or already pinned — never double-inject.
    if (RESUME_FLAG_RE.test(cmd)) {
        return { command: cmd, chatSessionId: extractSessionId(cmd), strategy: profile.strategy };
    }
    const existing = extractSessionId(cmd);
    if (existing) {
        return { command: cmd, chatSessionId: existing, strategy: profile.strategy };
    }

    if (profile.strategy === 'flag' && profile.flagTemplate) {
        const id = genId();
        const flag = profile.flagTemplate.replace('{id}', id);
        return { command: `${cmd} ${flag}`.trim(), chatSessionId: id, strategy: 'flag' };
    }
    return { command: cmd, chatSessionId: null, strategy: profile.strategy };
}

/** Strip any session-id / resume flag (+ its id) from a command, so a resume can
 *  be (re)built cleanly without double-flagging. */
function stripSessionFlags(command: string): string {
    return String(command ?? '')
        .replace(/\s*--session-id(?:=|\s+)[0-9a-fA-F-]{8,}/g, '')
        .replace(/\s*(?:--resume|--continue)(?:=|\s+)[0-9a-fA-F-]{8,}/g, '')
        .trim();
}

/**
 * Build the command to RESUME an agent's captured chat session — the heart of a
 * GRACEFUL restart: re-launching the SAME conversation so the TUI reconnects to
 * the (updated) MCP rig without losing context (wish #88). Claude resumes with
 * `--resume <id>` (confirmed flag). Any existing session/resume flag is stripped
 * first so we never double-flag.
 *
 * Returns null when there's no captured id, or the agent can't be safely resumed
 * (codex has no capture in v1; a `custom` wrapper's resume syntax is unknown) — so
 * the caller REFUSES rather than silently launching a fresh, context-less session.
 */
export function renderAgentResume(
    agent: WhisperAgentType,
    baseCommand: string,
    sessionId: string | null,
): string | null {
    if (!sessionId) return null;
    // Only claude has a confirmed resume flag; codex/custom can't be resumed
    // generically without risking a broken re-launch.
    if (agent !== 'claude') return null;
    const base = stripSessionFlags(baseCommand) || 'claude';
    return `${base} --resume ${sessionId}`;
}

/**
 * Resume the MOST-RECENT chat in the terminal's cwd via `--continue` (`-c`) — the
 * robust fallback when a captured session id can't be resumed by exact id. Claude
 * scopes `-c` to the current project dir, so it reconnects the last conversation
 * there without needing the (possibly drifted) id. Used when the stored
 * `chat_session_id` has no transcript on disk: `--resume <that id>` would dead-end
 * "No conversation found", so we continue the latest instead of scaring the user.
 * Claude-only (codex/custom have no generic continue) — null otherwise.
 */
export function renderAgentContinue(
    agent: WhisperAgentType,
    baseCommand: string,
): string | null {
    if (agent !== 'claude') return null;
    const base = stripSessionFlags(baseCommand) || 'claude';
    return `${base} --continue`;
}

/** The agent-relevant slice of a terminal spec's meta (loose so this stays free of
 *  the heavy db types). */
interface AgentSpecLike {
    meta?: {
        agent?: string;
        agent_command?: string;
        chat_session_id?: string;
    } | null;
}

/**
 * Fresh-vs-continue decision for an AGENT terminal on a FRESH pty spawn (a restart /
 * reopen where the previous shell + agent died). The spec's captured `chat_session_id`
 * is the signal:
 *   - present → RESUME the same conversation (`claude --resume <id>`) — a restart
 *               continues where it left off (the graceful resume the MCP
 *               `runAgent restart` uses).
 *   - absent  → a fresh launch (mints a new session id) — a first spawn, or an agent
 *               whose session was never captured (e.g. codex has no resume in v1).
 * Returns the command to submit (+ any minted session id to persist), or null when
 * there's nothing to (re)launch: a WARM reattach (`existing` — the agent is still
 * running) or a non-agent terminal. Pure — the caller does the pty/db side-effects.
 */
export function agentRelaunchDecision(
    spec: AgentSpecLike | null,
    existing: boolean,
    sessionExists?: (sessionId: string) => boolean,
): { command: string; newSessionId?: string } | null {
    if (existing || !spec) return null;
    const agent = spec.meta?.agent as WhisperAgentType | undefined;
    if (!agent) return null;
    const baseCmd = spec.meta?.agent_command ?? '';
    const sid = spec.meta?.chat_session_id ?? null;

    // A captured session id: resume it by EXACT id only when its transcript
    // actually exists on disk. The stored id can DRIFT from the live conversation
    // (the user recovered a killed chat with `-c`, or claude regenerated the id),
    // and `--resume <a phantom id>` dead-ends with "No conversation found" — worse
    // than useless, it looks like lost work. When the id can't be verified, fall
    // back to `--continue` (resume the most-recent chat in this cwd), which is
    // robust to that drift. `sessionExists` is injected (the fs check lives in the
    // caller); omitted → trust the id (preserves the pre-verification behaviour).
    if (sid) {
        const verified = sessionExists ? sessionExists(sid) : true;
        if (verified) {
            const resume = renderAgentResume(agent, baseCmd, sid);
            if (resume) return { command: resume };
        } else {
            const cont = renderAgentContinue(agent, baseCmd);
            if (cont) return { command: cont };
            // Non-claude with a stale id can't continue — fall through to fresh.
        }
    }

    const r = renderAgentLaunch(agent, baseCmd);
    if (!r.command) return null;
    return r.chatSessionId && !sid
        ? { command: r.command, newSessionId: r.chatSessionId }
        : { command: r.command };
}

/**
 * Append a user's ALWAYS-ON launch flags to a base agent command. Both sides are
 * trimmed; empty/whitespace flags are a no-op. Pure so the flag behaviour is
 * unit-testable independent of the settings read. The session-id flag is added
 * AFTER this (by {@link renderAgentLaunch}), so a command built here that already
 * contains `--session-id` is handled by that step's idempotency check.
 */
export function appendLaunchFlags(base: string, flags: string | undefined): string {
    const b = String(base ?? '').trim();
    const f = String(flags ?? '').trim();
    return f ? `${b} ${f}` : b;
}

/**
 * Claude Code's transcript dir for a cwd: `~/.claude/projects/<encoded>` where
 * the cwd is encoded by replacing every non-alphanumeric run's chars with `-`
 * (e.g. `C:\_Projects\tynn.ai` → `C---Projects-tynn-ai`).
 */
export function transcriptDirFor(cwd: string, home: string = os.homedir()): string {
    const encoded = String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-');
    return path.join(home, '.claude', 'projects', encoded);
}

/** The session id encoded in a transcript filename (its stem), or null. */
export function sessionIdFromTranscriptFile(file: string): string | null {
    const base = path.basename(String(file ?? ''));
    if (!base.endsWith('.jsonl')) return null;
    const stem = base.slice(0, -'.jsonl'.length);
    return stem || null;
}

/**
 * Pick the newest session id from a dir listing that WASN'T present before launch
 * — pure so it's testable. `before` is the set of pre-launch filenames; `entries`
 * are `{ name, mtimeMs }` for the current `*.jsonl` files. Returns the id of the
 * newest brand-new transcript, or null.
 */
export function pickNewSessionId(
    entries: Array<{ name: string; mtimeMs: number }>,
    before: Set<string>,
): string | null {
    const fresh = entries
        .filter((e) => e.name.endsWith('.jsonl') && !before.has(e.name))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const e of fresh) {
        const id = sessionIdFromTranscriptFile(e.name);
        if (id) return id;
    }
    return null;
}

/** List a transcript dir's `*.jsonl` entries with mtimes (empty on any error). */
function listTranscripts(dir: string): Array<{ name: string; mtimeMs: number }> {
    try {
        return fs
            .readdirSync(dir)
            .filter((n) => n.endsWith('.jsonl'))
            .map((name) => {
                let mtimeMs = 0;
                try {
                    mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
                } catch {
                    /* raced deletion — treat as ancient */
                }
                return { name, mtimeMs };
            });
    } catch {
        return [];
    }
}

/**
 * DETECT strategy: after launching, poll the transcript dir for a NEW `*.jsonl`
 * (its stem is the session id). Best-effort + bounded (`timeoutMs`, `intervalMs`).
 * Resolves the id, or null if none appears in time. Never throws.
 */
export function captureSessionByDetect(
    cwd: string,
    opts: {
        timeoutMs?: number;
        intervalMs?: number;
        transcriptDir?: string;
    } = {},
): Promise<string | null> {
    const dir = opts.transcriptDir ?? transcriptDirFor(cwd);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 1_000;
    const before = new Set(listTranscripts(dir).map((e) => e.name));
    const start = Date.now();

    return new Promise((resolve) => {
        const tick = (): void => {
            const id = pickNewSessionId(listTranscripts(dir), before);
            if (id) {
                resolve(id);
                return;
            }
            if (Date.now() - start >= timeoutMs) {
                resolve(null);
                return;
            }
            const timer = setTimeout(tick, intervalMs);
            if (typeof (timer as { unref?: () => void }).unref === 'function') {
                (timer as { unref: () => void }).unref();
            }
        };
        tick();
    });
}
