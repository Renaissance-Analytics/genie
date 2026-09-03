import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { AgentInboxAgentType } from './types';
import { isTuiId, providerDef } from '../agents/registry';

/**
 * Capture an AI TUI's CHAT-SESSION identity when Genie launches it, so a
 * specialized terminal can be tied back to its conversation (surfaced on the
 * agent list + AgentInbox).
 *
 * Two strategies, per a small per-agent PROFILE:
 *   - `flag`   — the CLI accepts a session-id flag on launch. We MINT a uuid and
 *                append the flag (unless the user's command already set one), so
 *                the id is known immediately. Claude Code supports
 *                `--session-id <uuid>` (confirmed at build time: `claude --help`).
 *   - `hook`   — the harness reports its generated id through a startup hook.
 *   - `detect` — no launch flag; after launch we briefly watch the transcript dir
 *                for the newest new `*.jsonl` (its filename stem IS the session id).
 *   - `none`   — no capture.
 *
 * The pure pieces (profile lookup, flag render, dir encoding, filename parse,
 * newest-pick) are unit-tested; only the watcher touches fs.
 */

export type SessionStrategy = 'flag' | 'hook' | 'detect' | 'none';

interface LaunchProfile {
    strategy: SessionStrategy;
    /** For `flag`: the flag template, `{id}` substituted with the minted uuid. */
    flagTemplate?: string;
}

/** Per-agent launch profiles. Codex binds through the managed SessionStart hook. */
export const LAUNCH_PROFILES: Record<AgentInboxAgentType, LaunchProfile> = {
    claude: { strategy: 'flag', flagTemplate: '--session-id {id}' },
    codex: { strategy: 'hook' },
    kiwi: { strategy: 'detect' },
    genie: { strategy: 'hook' },
    custom: { strategy: 'detect' },
};

/** A launch already carries a session id / is resuming — don't inject a flag. */
const SESSION_FLAG_RE = /(^|\s)--session-id(=|\s)/;
const CLAUDE_RESUME_FLAG_RE = /(^|\s)(--resume|--continue|-r|-c)(=|\s|$)/;
const CODEX_RESUME_SUBCOMMAND_RE = /^\s*codex(?:\.exe)?\s+resume(?:\s|$)/i;

/** Session ids later become one unquoted CLI argument, so keep them shell-inert. */
export function isSafeSessionId(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value ?? ''));
}

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
    agent: AgentInboxAgentType,
    command: string,
    genId: () => string = () => crypto.randomUUID(),
): RenderedLaunch {
    const profile = LAUNCH_PROFILES[agent] ?? { strategy: 'none' as const };
    const cmd = String(command ?? '');

    // Already resuming or already pinned — never double-inject.
    const resuming =
        agent === 'claude'
            ? CLAUDE_RESUME_FLAG_RE.test(cmd)
            : agent === 'codex'
              ? CODEX_RESUME_SUBCOMMAND_RE.test(cmd)
              : false;
    if (resuming) {
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

/** Quote a registry-supplied binary/token for use inside a built RegExp. */
function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the command to RESUME an agent's captured chat session — the heart of a
 * GRACEFUL restart: re-launching the SAME conversation so the TUI reconnects to
 * the (updated) MCP rig without losing context (wish #88). Any existing
 * session/resume flag is stripped first so we never double-flag.
 *
 * WHICH providers resume, and with what syntax, is `TuiDef.resume` in
 * `agents/registry.ts` — not a literal here (genie#261). This function owns the
 * ARGV: where the id goes relative to the provider's own options. That split is
 * the point: the terminal context menu asks the registry whether to offer
 * "Restart agent", so its answer cannot drift from the command built here. It
 * did drift — the menu was claude-only while codex resumed fine — and that is
 * the bug this arrangement makes unrepresentable.
 *
 * Returns null when there's no captured id, or the provider has no known resume
 * grammar (a `custom` wrapper's syntax is its author's, not Genie's) — so the
 * caller REFUSES rather than silently launching a fresh, context-less session.
 */
export function renderAgentResume(
    agent: AgentInboxAgentType,
    baseCommand: string,
    sessionId: string | null,
): string | null {
    if (!sessionId || !isSafeSessionId(sessionId)) return null;
    // `agent` reaches here from stored spec meta, so an id this build does not
    // know is a real case, not a cannot-happen. It resumes like anything else
    // with no grammar: it does not.
    if (!isTuiId(agent)) return null;
    const def = providerDef(agent);
    const grammar = def.resume;
    if (!grammar) return null;

    if (grammar.kind === 'subcommand') {
        // `codex resume [options] <id>` — the id is POSITIONAL and goes last, so
        // the `-c` TOML overrides Genie injects stay ahead of it. The base
        // command is split rather than stripped because the subcommand has to
        // land immediately after the binary.
        const binary = def.defaultCommand || agent;
        const raw = String(baseCommand ?? '').trim() || binary;
        const shape = new RegExp(
            `^(${escapeForRegExp(binary)}(?:\\.exe)?)(?:\\s+${escapeForRegExp(grammar.token)})?(?:\\s+(.*))?$`,
            'i',
        );
        const match = raw.match(shape);
        if (!match) return null;
        const options = (match[2] ?? '').trim();
        return `${match[1]} ${grammar.token}${options ? ` ${options}` : ''} ${sessionId}`;
    }

    const base = stripSessionFlags(baseCommand) || def.defaultCommand || agent;
    return `${base} ${grammar.token} ${sessionId}`;
}

/**
 * Resume the MOST-RECENT chat in the terminal's cwd via `--continue` (`-c`) — the
 * robust fallback when a captured session id can't be resumed by exact id. Claude
 * scopes `-c` to the current project dir, so it reconnects the last conversation
 * there without needing the (possibly drifted) id. Used when the stored
 * `chat_session_id` has no transcript on disk: `--resume <that id>` would dead-end
 * "No conversation found", so we continue the latest instead of scaring the user.
 *
 * Whether a provider HAS such a flag is `TuiDef.resume.continueFlag`, not a
 * literal here. Only claude declares one today — codex genuinely has no generic
 * continue — but that is now a row in the table rather than an `if` that the
 * next provider has to remember to visit.
 */
export function renderAgentContinue(
    agent: AgentInboxAgentType,
    baseCommand: string,
): string | null {
    if (!isTuiId(agent)) return null;
    const def = providerDef(agent);
    const flag = def.resume?.continueFlag;
    if (!flag) return null;
    const base = stripSessionFlags(baseCommand) || def.defaultCommand || agent;
    return `${base} ${flag}`;
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
 * The session id a RELAUNCH should resume — `meta.chat_session_id` when it is
 * there, otherwise the id sitting inside the stored launch command's
 * `--session-id` flag.
 *
 * The second half is genie#364. `--session-id <uuid>` is CREATE-a-session-with-
 * this-id: {@link renderAgentLaunch} MINTS the uuid so the conversation is
 * identified from the first keystroke, and is idempotent about a flag that is
 * already present. That means the id can end up recorded ONLY in the stored
 * command — the owner's always-on flags may pin one, and a spec written by an
 * older build has one baked in. Reading it here is what lets a relaunch change
 * the flag's VERB (`--resume`) instead of replaying a create that can only ever
 * succeed once ("Error: Session ID <uuid> is already in use").
 *
 * `chat_session_id` OUTRANKS the command: it is the live record, updated when a
 * session is detected or re-captured, while a command string can hold a stale id
 * indefinitely.
 */
export function capturedSessionId(spec: AgentSpecLike | null): string | null {
    const meta = spec?.meta;
    if (!meta) return null;
    const stored = meta.chat_session_id?.trim();
    if (stored) return stored;
    return extractSessionId(meta.agent_command ?? '');
}

/**
 * Fresh-vs-continue decision for an AGENT terminal on a FRESH pty spawn (a restart /
 * reopen where the previous shell + agent died). The spec's captured session id
 * ({@link capturedSessionId}) is the signal:
 *   - present → RESUME the same conversation (`claude --resume <id>`) — a restart
 *               continues where it left off (the graceful resume the MCP
 *               `runAgent restart` uses).
 *   - absent  → a fresh launch (mints a new session id when supported).
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
    const agent = spec.meta?.agent as AgentInboxAgentType | undefined;
    if (!agent) return null;
    const baseCmd = spec.meta?.agent_command ?? '';
    const sid = capturedSessionId(spec);

    // A captured session id: resume it by EXACT id only when its transcript
    // actually exists on disk. The stored id can DRIFT from the live conversation
    // (the user recovered a killed chat with `-c`, or claude regenerated the id),
    // and `--resume <a phantom id>` dead-ends with "No conversation found" — worse
    // than useless, it looks like lost work. When the id can't be verified, fall
    // back to `--continue` (resume the most-recent chat in this cwd), which is
    // robust to that drift. `sessionExists` is injected (the fs check lives in the
    // caller); omitted → trust the id (preserves the pre-verification behaviour).
    if (sid) {
        // Only Claude's ids map to the transcript directory checked by the
        // caller. Codex's id comes from SessionStart and is resumed directly.
        const verified = agent === 'claude' && sessionExists ? sessionExists(sid) : true;
        if (verified) {
            const resume = renderAgentResume(agent, baseCmd, sid);
            if (resume) return { command: resume };
        } else {
            const cont = renderAgentContinue(agent, baseCmd);
            if (cont) return { command: cont };
            // Non-claude with a stale id can't continue — fall through to fresh.
        }
    }

    // GENUINELY FRESH — nothing captured, or a provider Genie cannot resume.
    // The stored command's session/resume flags are stripped FIRST: a create
    // flag is one-shot, so carrying one into a relaunch is not "preserving the
    // conversation", it is a guaranteed `Session ID … is already in use`
    // (genie#364). Everything that COULD have preserved it has already been
    // tried above, and which providers can is `TuiDef.resume`, not an `if` here.
    const r = renderAgentLaunch(agent, stripSessionFlags(baseCmd));
    if (!r.command) return null;
    return r.chatSessionId && !sid
        ? { command: r.command, newSessionId: r.chatSessionId }
        : { command: r.command };
}

/**
 * The command a GRACEFUL RESTART (wish #88 / #216) should relaunch an agent with,
 * or a refusal. Resumes the captured session by exact id ONLY when its transcript
 * exists on disk; when that id has DRIFTED (verified false), falls back to
 * `--continue` (resume the most-recent chat in the cwd) instead of the phantom
 * `--resume <id>` that dead-ends with "No conversation found" — which reads to the
 * user as lost work. REFUSES (returns an `error`, no command) when the terminal
 * has no resumable conversation — a non-agent, an unsupported custom wrapper,
 * or a supported agent with no captured session — so a restart can never silently drop the agent into
 * a fresh, context-less session.
 *
 * Pure: the on-disk check is injected and the caller does the pty side-effects.
 * This is the decision `restartAgentTerminal` uses; the earlier version called
 * {@link renderAgentResume} directly and so skipped the drift check.
 */
export function resolveRestartCommand(
    spec: AgentSpecLike | null,
    sessionExists: (sessionId: string) => boolean,
): { command: string } | { error: string } {
    const agent = spec?.meta?.agent as AgentInboxAgentType | undefined;
    if (!spec || !agent) return { error: 'Not an agent terminal.' };

    const base = spec.meta?.agent_command ?? '';
    const sid = capturedSessionId(spec);
    // Resumable when the provider has confirmed exact-resume grammar and a
    // captured session id (Claude flag or Codex subcommand).
    if (!renderAgentResume(agent, base, sid)) {
        return {
            error:
                `Cannot gracefully restart "${agent}": no captured session to resume, so a restart ` +
                'would lose the conversation. A captured session id is required.',
        };
    }
    // Verified id → --resume; drifted id → --continue. Never a fresh mint here
    // (the guard above guarantees claude+sid, so the decision preserves the chat).
    const decision = agentRelaunchDecision(spec, false, sessionExists);
    if (!decision?.command) {
        return { error: `Cannot resolve a resume command for "${agent}".` };
    }
    return { command: decision.command };
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
