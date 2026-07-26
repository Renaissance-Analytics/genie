import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ANTHROPIC, API_KEY, OPENAI, SCOPE_PROJECT, type OpenedCredential } from './escrow';

/**
 * Getting an OPENED credential into the shape each agent CLI actually reads —
 * the last hop of the managed-credential path, and the only place a plaintext
 * value touches anything outside process memory.
 *
 * **`kind`, not `provider`, decides the destination:**
 *
 * - **`api_key`** → the terminal environment (`ANTHROPIC_API_KEY`,
 *   `OPENAI_API_KEY`). Nothing on disk. Per-process, so project scope works.
 * - **`github` + `api_key`** → `gh auth login --with-token`, piped on **STDIN**.
 *   Never argv: a process's command line is world-readable (`ps -e`), so a token
 *   in argv is a token leaked to every local user.
 * - **`anthropic` + `subscription`** → `~/.claude/.credentials.json`, 0600 in a
 *   0700 `.claude/`, because that is the only interface the Claude CLI offers.
 *   It is NOT put in the environment as well — that would be a second copy in a
 *   place every child process inherits.
 *
 * That `anthropic` appears with BOTH kinds, materializing two completely
 * different ways, is exactly why the descriptor can't collapse to one slug.
 *
 * **Scope reaches only as far as the mechanism does.** An env var is per-process,
 * so a `project`-scoped api_key cleanly overrides the account one for that
 * workspace's terminals. `gh auth login` and `~/.claude/.credentials.json` are
 * **one per host** — there is no per-project variant of either — so those fall to
 * {@link resolveHostGlobal}, which prefers the account credential and REFUSES to
 * guess between competing project ones.
 *
 * Every failure path here returns a flag + a **redacted** reason. An underlying
 * error (or gh's own stderr) can quote the value back at us, so the value is
 * scrubbed out before the reason is ever returned, let alone logged.
 */

/** Mode for the materialized Claude credential file — owner read/write only. */
export const CLAUDE_CREDENTIALS_MODE = 0o600;
/** Mode for the `.claude/` directory that holds it. */
export const CLAUDE_DIR_MODE = 0o700;

/** `provider/kind` → the env var the agent CLI reads. A pair absent from this
 *  map is materialized some other way (or not at all) and MUST NOT reach env. */
const ENV_VARS: Record<string, string> = {
    [`${ANTHROPIC}/${API_KEY}`]: 'ANTHROPIC_API_KEY',
    [`${OPENAI}/${API_KEY}`]: 'OPENAI_API_KEY',
};

/**
 * The env var a credential is injected as, or null when it is materialized some
 * other way (the GitHub token, the Claude subscription) and must NEVER reach an
 * environment. Keyed on `provider` AND `kind` because the pair is what decides:
 * `anthropic/api_key` is an env var, `anthropic/subscription` is a file.
 */
export function envVarForCredential(credential: { provider: string; kind: string }): string | null {
    return ENV_VARS[`${credential.provider}/${credential.kind}`] ?? null;
}

/**
 * The env fragment for a terminal, resolved for `projectId` (the workspace that
 * terminal belongs to, when it has one).
 *
 * Per env var, a `project`-scoped credential matching `projectId` wins over the
 * `account` one — that is the owner's per-workspace override. A project
 * credential for a DIFFERENT workspace is ignored entirely rather than falling
 * back into this one, so workspace A's key can never leak into workspace B.
 *
 * Blank values are dropped rather than exported as empty strings: an empty
 * `ANTHROPIC_API_KEY` is worse than an absent one, since the CLI treats it as set.
 */
export function credentialEnv(
    credentials: OpenedCredential[],
    projectId?: string | null,
): Record<string, string> {
    const env: Record<string, string> = {};
    const fromProject = new Set<string>();
    for (const credential of credentials ?? []) {
        const envVar = envVarForCredential(credential);
        const value = credential.value?.trim();
        if (!envVar || !value) continue;

        if (credential.scope === SCOPE_PROJECT) {
            // Only this workspace's own override applies.
            if (!projectId || credential.projectId !== projectId) continue;
            env[envVar] = value;
            fromProject.add(envVar);
            continue;
        }
        // Account scope never displaces a project override already resolved.
        if (!fromProject.has(envVar)) env[envVar] = value;
    }
    return env;
}

export type HostGlobalStatus = 'ok' | 'absent' | 'ambiguous';

export interface HostGlobalResolution {
    status: HostGlobalStatus;
    credential?: OpenedCredential;
    /** On 'ambiguous', the competing credential IDs — ids only, never values. */
    conflictIds?: string[];
}

/**
 * Pick the ONE credential for a host-global materialization (`gh auth login`,
 * `~/.claude/.credentials.json`). Both are single-slot per host: one home
 * directory, one gh auth state, and the Claude CLI offers no per-directory
 * credential path, so two project-scoped credentials cannot both be live.
 *
 * Account scope wins. With no account credential and exactly ONE project-scoped
 * candidate, that one is used — better than leaving the host unauthenticated.
 * With SEVERAL, this returns `ambiguous` and materializes nothing: silently
 * picking would authenticate every agent on the host as one workspace's
 * identity, which is worse than having no credential at all.
 */
export function resolveHostGlobal(
    credentials: OpenedCredential[],
    provider: string,
    kind: string,
): HostGlobalResolution {
    const matches = (credentials ?? []).filter(
        (c) => c.provider === provider && c.kind === kind && c.value?.trim(),
    );
    const account = matches.find((c) => c.scope !== SCOPE_PROJECT);
    if (account) return { status: 'ok', credential: account };

    const scoped = matches.filter((c) => c.scope === SCOPE_PROJECT);
    if (scoped.length === 1) return { status: 'ok', credential: scoped[0] };
    if (scoped.length > 1) {
        return { status: 'ambiguous', conflictIds: scoped.map((c) => c.id) };
    }
    return { status: 'absent' };
}

/** The subset of `node:fs` THIS module uses — injected so tests never need real
 *  IO to assert the modes and the refuse-to-write paths. */
export interface MaterializerFs {
    mkdirSync(dir: string, opts: { recursive: boolean; mode?: number }): void;
    writeFileSync(file: string, data: string, opts: { mode: number; encoding: BufferEncoding }): void;
    chmodSync(file: string, mode: number): void;
    existsSync(file: string): boolean;
    rmSync(file: string, opts: { force: boolean }): void;
}

/**
 * The FULL filesystem surface the credential path needs — writing (here) plus
 * reading back (rotation detection). Anything wiring the whole flow injects this
 * one, so a caller cannot hand the orchestrator a write-only fs and silently
 * lose rotation write-back.
 */
export interface CredentialFs extends MaterializerFs {
    readFileSync(file: string): string;
}

export interface MaterializeDeps {
    /** Overrides `os.homedir()` — the protected home (genie_home on cloud). */
    homeDir?: string;
    fs?: MaterializerFs;
}

const defaultFs: MaterializerFs = {
    mkdirSync: (dir, opts) => void nodeFs.mkdirSync(dir, opts),
    writeFileSync: (file, data, opts) => nodeFs.writeFileSync(file, data, opts),
    chmodSync: (file, mode) => nodeFs.chmodSync(file, mode),
    existsSync: (file) => nodeFs.existsSync(file),
    rmSync: (file, opts) => nodeFs.rmSync(file, opts),
};

/** Where the Claude CLI keeps its credential blob, under `homeDir`. */
export function claudeCredentialsPath(homeDir: string = os.homedir()): string {
    return path.join(homeDir, '.claude', '.credentials.json');
}

/**
 * Strip every occurrence of `secret` out of a message before it can be returned
 * or logged. Defence in depth: the callers below never log, but an error raised
 * from underneath (or a CLI's stderr) may quote the value we handed it.
 */
function redact(message: string, secret: string): string {
    const trimmed = secret.trim();
    return trimmed ? message.split(trimmed).join('[redacted]') : message;
}

export interface MaterializeResult {
    ok: boolean;
    path: string;
    /** Redacted failure detail — never contains the credential. */
    reason?: string;
}

/**
 * Write the opened Claude subscription blob to `~/.claude/.credentials.json`
 * with 0600 in a 0700 `.claude/`. The mode is re-applied explicitly after the
 * write because `writeFileSync`'s `mode` only applies when the file is CREATED —
 * an existing file keeps whatever (possibly looser) mode it already had.
 *
 * A blank value is refused: overwriting a working credential with nothing is
 * strictly worse than leaving the old one in place for the CLI to reject.
 */
export function materializeClaudeCredentials(
    blob: string,
    deps: MaterializeDeps = {},
): MaterializeResult {
    const fsImpl = deps.fs ?? defaultFs;
    const file = claudeCredentialsPath(deps.homeDir);
    if (!blob?.trim()) {
        return { ok: false, path: file, reason: 'Refusing to write a blank Claude credential.' };
    }
    try {
        fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: CLAUDE_DIR_MODE });
        fsImpl.writeFileSync(file, blob, { mode: CLAUDE_CREDENTIALS_MODE, encoding: 'utf8' });
        // `mode` on write only takes effect on creation — force it for the
        // already-exists case so a previously world-readable file is tightened.
        fsImpl.chmodSync(file, CLAUDE_CREDENTIALS_MODE);
        return { ok: true, path: file };
    } catch (e) {
        return { ok: false, path: file, reason: redact(String(e), blob) };
    }
}

/**
 * Immediate revoke: remove the materialized credential file NOW.
 *
 * Removal only — no overwrite pass. On the journaling / copy-on-write
 * filesystems these hosts actually run, overwriting in place does not reliably
 * destroy the old blocks, so it would buy a false sense of erasure rather than a
 * guarantee. The real controls are the 0600 mode and the protected home.
 */
export function wipeClaudeCredentials(deps: MaterializeDeps = {}): boolean {
    const fsImpl = deps.fs ?? defaultFs;
    const file = claudeCredentialsPath(deps.homeDir);
    try {
        if (fsImpl.existsSync(file)) fsImpl.rmSync(file, { force: true });
        return true;
    } catch {
        return false;
    }
}

/** Spawning seam for the `gh` CLI — injected so tests assert the argv/stdin
 *  split without a real GitHub CLI on the machine. */
export interface CommandRunner {
    run(
        command: string,
        args: string[],
        opts: { input: string },
    ): Promise<{ code: number; stderr: string }>;
}

const defaultRunner: CommandRunner = {
    run: (command, args, opts) =>
        new Promise((resolve, reject) => {
            const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr?.on('data', (chunk) => {
                stderr += String(chunk);
            });
            child.on('error', reject);
            child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
            child.stdin?.end(opts.input);
        }),
};

export interface ApplyResult {
    ok: boolean;
    /** Redacted failure detail — never contains the token. */
    reason?: string;
}

/**
 * Hand the opened GitHub token to the `gh` CLI so every git/gh operation on this
 * host authenticates as the owner. The token goes on **stdin** (`--with-token`),
 * never in argv, and any failure detail is redacted before it is returned.
 */
export async function applyGithubToken(
    token: string,
    deps: { runner?: CommandRunner } = {},
): Promise<ApplyResult> {
    const runner = deps.runner ?? defaultRunner;
    const value = token?.trim();
    if (!value) return { ok: false, reason: 'Refusing to run gh with a blank token.' };
    try {
        const { code, stderr } = await runner.run(
            'gh',
            ['auth', 'login', '--hostname', 'github.com', '--with-token'],
            { input: value },
        );
        if (code === 0) return { ok: true };
        return { ok: false, reason: redact(`gh auth login exited ${code}: ${stderr}`.trim(), value) };
    } catch (e) {
        return { ok: false, reason: redact(`gh auth login failed: ${String(e)}`, value) };
    }
}
