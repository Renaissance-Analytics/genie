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
