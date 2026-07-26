import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ANTHROPIC_API_KEY, CLAUDE_SUBSCRIPTION, GITHUB_TOKEN, OPENAI_API_KEY } from './escrow';

/**
 * Getting an OPENED credential into the shape each agent CLI actually reads —
 * the last hop of the managed-credential path, and the only place a plaintext
 * value touches anything outside process memory.
 *
 * Three destinations, deliberately different:
 *
 * - **API keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) → the terminal
 *   environment. Nothing on disk.
 * - **GitHub token** → `gh auth login --with-token`, piped on **STDIN**. Never
 *   argv: a process's command line is world-readable (`ps -e`), so a token in
 *   argv is a token leaked to every local user.
 * - **Claude subscription** → `~/.claude/.credentials.json`, 0600 in a 0700
 *   `.claude/`, because that is the only interface the Claude CLI offers. It is
 *   NOT put in the environment as well — that would be a second copy in a place
 *   every child process inherits.
 *
 * Every failure path here returns a flag + a **redacted** reason. An underlying
 * error (or gh's own stderr) can quote the value back at us, so the value is
 * scrubbed out before the reason is ever returned, let alone logged.
 */

/** Mode for the materialized Claude credential file — owner read/write only. */
export const CLAUDE_CREDENTIALS_MODE = 0o600;
/** Mode for the `.claude/` directory that holds it. */
export const CLAUDE_DIR_MODE = 0o700;

/** provider slug → the env var the agent CLI reads. Providers absent from this
 *  map are materialized some other way (or not at all) and MUST NOT reach env. */
const ENV_PROVIDERS: Record<string, string> = {
    [ANTHROPIC_API_KEY]: 'ANTHROPIC_API_KEY',
    [OPENAI_API_KEY]: 'OPENAI_API_KEY',
};

/**
 * The env var a provider is injected as, or null when it is materialized some
 * other way (GitHub token, Claude subscription) and must NEVER reach an
 * environment. The single source of truth for that mapping in both directions —
 * a revoke names a provider and needs the variable to unset.
 */
export function envVarForProvider(provider: string): string | null {
    return ENV_PROVIDERS[provider] ?? null;
}

/**
 * The env fragment for a set of opened credentials. Only the providers in
 * {@link ENV_PROVIDERS} appear — the GitHub token and the Claude subscription
 * are intentionally excluded so they never ride a child process's environment.
 * Blank values are dropped rather than exported as empty strings (an empty
 * `ANTHROPIC_API_KEY` is worse than an absent one: the CLI treats it as set).
 */
export function credentialEnv(values: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [provider, value] of Object.entries(values)) {
        const envVar = envVarForProvider(provider);
        if (envVar && value?.trim()) env[envVar] = value.trim();
    }
    return env;
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
