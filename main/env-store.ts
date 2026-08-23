import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    parseEnv,
    upsertEnvLine,
    upsertEnvBlock,
    isValidEnvKey,
    isSecret,
    obfuscateSecret,
} from './env-file';

/**
 * `.env` file operations backing Part A (the Tynn token's new home) + the
 * `setEnv` / `checkEnv` MCP tools. Targets resolve to a path WITHIN the
 * workspace, with a traversal guard:
 *   - `workspace` (default) → `<workspaceRoot>/.env`
 *   - a repo name           → `<workspaceRoot>/repos/<name>/.env`
 */

export interface EnvTarget {
    path: string;
    /** The directory the `.env` lives in (for the gitignore write). */
    dir: string;
    /** Human label returned to the agent (e.g. `.env` or `repos/web/.env`). */
    label: string;
    kind: 'workspace' | 'repo';
}

/** Resolve a target to its `.env` path (pure — path math + a traversal guard).
 *  Existence of a `repo` dir is checked by the callers (they touch fs anyway). */
export function resolveEnvTarget(
    workspaceRoot: string,
    target?: string,
): { ok: true; target: EnvTarget } | { ok: false; error: string } {
    if (!target || target === 'workspace') {
        return {
            ok: true,
            target: { path: path.join(workspaceRoot, '.env'), dir: workspaceRoot, label: '.env', kind: 'workspace' },
        };
    }
    const name = target.trim();
    if (
        !name ||
        name === 'workspace' ||
        name.includes('/') ||
        name.includes('\\') ||
        name.includes('..') ||
        path.isAbsolute(name)
    ) {
        return { ok: false, error: `invalid repo target '${target}' — pass a single repo name under repos/` };
    }
    const reposDir = path.join(workspaceRoot, 'repos');
    const repoDir = path.join(reposDir, name);
    const rel = path.relative(reposDir, repoDir);
    if (rel !== name || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, error: `invalid repo target '${target}'` };
    }
    return {
        ok: true,
        target: { path: path.join(repoDir, '.env'), dir: repoDir, label: `repos/${name}/.env`, kind: 'repo' },
    };
}

function readFileOrEmpty(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

/**
 * Replace a file's contents with NO window in which it is truncated or partial.
 *
 * `fs.writeFileSync` opens with `O_TRUNC`: the user's `.env` is empty from that
 * instant until the new bytes land. A crash, a full disk or a killed process in
 * between leaves them with nothing — and this writer runs unattended on a service
 * lifecycle tick, so nobody is watching when it happens. Write a sibling temp file
 * and `rename` it over the target instead; rename is atomic on both NTFS and every
 * POSIX filesystem, so a reader sees either all the old bytes or all the new ones.
 *
 * Two things this must NOT do while being careful:
 *
 *  - **Replace a symlink with a regular file.** A `.env` symlinked to a shared
 *    secrets file is a real setup, and renaming onto the LINK silently detaches it.
 *    Resolve to the real path first and write there — which is what the old
 *    `writeFileSync` did by accident, and what this must keep doing on purpose.
 *  - **Bulldoze a read-only file.** On POSIX, renaming over a read-only file
 *    SUCCEEDS as long as the directory is writable, so switching to rename would
 *    have started overwriting files the user had deliberately locked — a
 *    regression dressed as a fix. Writability is therefore checked explicitly, and
 *    the answer is the same on every platform.
 */
function writeFileAtomic(file: string, content: string): void {
    // A symlink is followed; a path that does not exist yet resolves to itself.
    let target = file;
    try {
        target = fs.realpathSync(file);
    } catch {
        /* not there yet — we are creating it */
    }

    // "Does not exist" (fine, we create it) and "exists but is not writable" (the
    // user's decision, which we honour) are different answers, so ask separately.
    let mode: number | undefined;
    try {
        mode = fs.statSync(target).mode & 0o777;
    } catch {
        /* not there yet — we are creating it */
    }
    if (mode !== undefined) {
        try {
            fs.accessSync(target, fs.constants.W_OK);
        } catch {
            throw new Error(`${path.basename(target)} is read-only — Genie left it untouched`);
        }
    }

    const dir = path.dirname(target);
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const temp = path.join(dir, `.${path.basename(target)}.genie-${unique}.tmp`);
    try {
        fs.writeFileSync(temp, content, mode === undefined ? undefined : { mode });
        fs.renameSync(temp, target);
    } catch (e) {
        try {
            fs.unlinkSync(temp);
        } catch {
            /* nothing to clean up */
        }
        throw e;
    }
}

/** Turn one `.gitignore` pattern into a matcher for a bare filename. */
function ignorePatternMatches(pattern: string, name: string): boolean {
    // Anchoring and directory prefixes are irrelevant for "does this cover a
    // `.env` sitting right here": `/.env`, `**/.env` and `.env` all do.
    const glob = pattern.replace(/^\/+/, '').replace(/^\*\*\//, '');
    if (glob === '' || glob.includes('/')) return false;
    const re = new RegExp(
        `^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`,
    );
    return re.test(name);
}

/**
 * Is `.env` ALREADY ignored by this `.gitignore`?
 *
 * The old check was `lines.includes('.env')`, which sees only the literal spelling
 * — so a repo whose `.gitignore` says `*.env`, `.env*` or `/.env` (all common, all
 * already correct) got a redundant entry appended. `.gitignore` is a TRACKED file:
 * that is an unrequested diff in somebody's repository, produced by a tool they
 * asked to manage a different file entirely.
 *
 * Last matching rule wins, so a later `!.env` genuinely un-ignores it.
 */
function gitignoreCovers(content: string, name = '.env'): boolean {
    let covered = false;
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const negated = line.startsWith('!');
        const pattern = negated ? line.slice(1) : line;
        if (ignorePatternMatches(pattern, name)) covered = !negated;
    }
    return covered;
}

/**
 * Append `.env` to a directory's `.gitignore` when it is not ALREADY covered (a
 * `.env` carries secrets — never commit it). Best-effort, mirroring
 * ensureMcpGitignored.
 */
export function ensureEnvGitignored(dir: string): void {
    const file = path.join(dir, '.gitignore');
    try {
        let content = '';
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch {
            /* no .gitignore yet — we create one */
        }
        if (gitignoreCovers(content)) return;
        const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
        const block = `${prefix}\n# Genie: .env carries secrets (e.g. the Tynn agent token) — never commit it.\n.env\n`;
        writeFileAtomic(file, content + block);
    } catch {
        /* best-effort */
    }
}

/**
 * Does git already TRACK this `.env`?
 *
 * Gitignoring a file git is already following does nothing at all — the next
 * `git add -A` still stages it, and Genie is about to write a service password
 * into it. Genie cannot fix this itself (`git rm --cached` on somebody's index is
 * not a thing an unattended service tick may do), so the honest move is to write
 * the value the app needs and SAY SO, rather than quietly making a credential
 * committable. Only ever asked when a write is actually happening.
 */
function envIsGitTracked(file: string): boolean {
    try {
        const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', path.basename(file)], {
            cwd: path.dirname(file),
            stdio: 'ignore',
            windowsHide: true,
        });
        return r.status === 0;
    } catch {
        // No git, not a repo, nothing to warn about.
        return false;
    }
}

/** Read a workspace `.env` into a plain env map for terminal injection. Empty
 *  when there's no `.env` (the common case) — never throws. */
export function loadWorkspaceEnvVars(workspaceRoot: string): Record<string, string> {
    if (!workspaceRoot) return {};
    const content = readFileOrEmpty(path.join(workspaceRoot, '.env'));
    if (!content) return {};
    return Object.fromEntries(parseEnv(content));
}

// --- setEnv / checkEnv request+result shapes (shared with the MCP layer) -----

export interface SetEnvRequest {
    key: string;
    value: string;
    /** `workspace` (default) or a repo name → `repos/<name>/.env`. */
    target?: string;
}
export interface SetEnvResult {
    ok: boolean;
    error?: string;
    /** The `.env` written (label), e.g. `.env` or `repos/web/.env`. */
    file?: string;
}

export interface CheckEnvRequest {
    key: string;
    target?: string;
    /** Return the value (default: presence check only). */
    value?: boolean;
    /** Return the FULL value even for a detected secret (default: obfuscated). */
    force?: boolean;
}
export interface CheckEnvResult {
    ok: boolean;
    error?: string;
    exists?: boolean;
    file?: string;
    /** Set when the key exists: whether it was detected as a secret. */
    isSecret?: boolean;
    /** Present only when `value` was requested + the key exists. */
    value?: string;
    /** True when `value` is the obfuscated (last-4) form of a secret. */
    obfuscated?: boolean;
}

/** Upsert KEY=value into the resolved `.env` (creating + gitignoring it). */
export function applySetEnv(workspaceRoot: string, req: SetEnvRequest): SetEnvResult {
    if (!isValidEnvKey(req.key)) {
        return { ok: false, error: `invalid env key '${req.key}' — use A–Z, 0–9, _ and start with a letter or _` };
    }
    const t = resolveEnvTarget(workspaceRoot, req.target);
    if (!t.ok) return { ok: false, error: t.error };
    if (t.target.kind === 'repo' && !fs.existsSync(t.target.dir)) {
        return { ok: false, error: `repo '${req.target}' not found under repos/` };
    }
    const next = upsertEnvLine(readFileOrEmpty(t.target.path), req.key, String(req.value ?? ''));
    try {
        fs.mkdirSync(t.target.dir, { recursive: true });
        writeFileAtomic(t.target.path, next);
    } catch (e) {
        return { ok: false, error: `write failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    ensureEnvGitignored(t.target.dir);
    return { ok: true, file: t.target.label };
}

// --- the managed service block (genie#242) ----------------------------------

export interface EnvBlockRequest {
    /** `workspace` (default) or a repo name → `repos/<name>/.env`. */
    target?: string;
    /** The managed keys and their CURRENT values. */
    vars: Record<string, string>;
    /** The comment that marks where NEW managed keys are appended. */
    header?: string;
}

export interface EnvBlockResult {
    ok: boolean;
    error?: string;
    /** The `.env` written (label), e.g. `repos/tynn/.env`. */
    file?: string;
    /** True only when bytes actually changed on disk. */
    changed: boolean;
    /** The keys this write moved. Empty when nothing had drifted. */
    keys: string[];
    /** The `.env` is TRACKED by git, so gitignoring it protects nothing. */
    gitTracked?: boolean;
    /** Something the user needs to know about a write that otherwise SUCCEEDED —
     *  surfaced rather than logged, because nobody is watching this happen. */
    warning?: string;
}

/** The default marker for the appended block. Deliberately says WHO wrote it and
 *  that it is maintained, so nobody hand-edits a port back and wonders why it
 *  reverts. */
export const MANAGED_ENV_HEADER =
    '# --- Genie: managed service connection — updated automatically (genie#242) ---';

/**
 * Write Genie's managed service keys into a repo's `.env` (genie#242).
 *
 * Read-modify-write over the user's own file: {@link upsertEnvBlock} holds the
 * safety contract (their edits survive, a key is rewritten where it already is,
 * new keys land in one marked block). This layer adds the things that touch the
 * disk:
 *
 *  - **Nothing changed ⇒ nothing written.** Not an identical rewrite — no write
 *    call at all, so the mtime a watcher or a build tool keys off does not move.
 *  - **The file is gitignored before it holds a credential.** A service password
 *    is about to land in it, and this is the same guarantee {@link applySetEnv}
 *    already makes for site env (genie#168).
 *  - **A write that cannot happen is REPORTED, never thrown.** This runs on a
 *    service lifecycle tick; a `.env` the user made read-only, or has open in an
 *    editor that holds a lock, must not be able to fail an engine acquire.
 */
export function applyEnvBlock(workspaceRoot: string, req: EnvBlockRequest): EnvBlockResult {
    const t = resolveEnvTarget(workspaceRoot, req.target);
    if (!t.ok) return { ok: false, error: t.error, changed: false, keys: [] };
    if (t.target.kind === 'repo' && !fs.existsSync(t.target.dir)) {
        return { ok: false, error: `repo '${req.target}' not found under repos/`, changed: false, keys: [] };
    }

    // Skip anything that is not a legal env name rather than writing a line no
    // parser would read back — one bad key must not cost the whole block.
    const vars = Object.fromEntries(
        Object.entries(req.vars).filter(([key]) => isValidEnvKey(key)),
    );

    const before = readFileOrEmpty(t.target.path);
    const after = upsertEnvBlock(before, vars, req.header ?? MANAGED_ENV_HEADER);
    if (after === before) {
        return { ok: true, file: t.target.label, changed: false, keys: [] };
    }

    const current = parseEnv(before);
    const keys = Object.keys(vars).filter((key) => current.get(key) !== vars[key]);
    // Gitignore FIRST: the bytes about to be written include a service password,
    // so the ordering is what makes "never committable" true even if the process
    // dies between the two writes.
    ensureEnvGitignored(t.target.dir);
    try {
        fs.mkdirSync(t.target.dir, { recursive: true });
        writeFileAtomic(t.target.path, after);
    } catch (e) {
        return {
            ok: false,
            error: `write failed: ${e instanceof Error ? e.message : String(e)}`,
            file: t.target.label,
            changed: false,
            keys: [],
        };
    }

    // Asked only now, because the answer only matters when bytes actually landed.
    if (envIsGitTracked(t.target.path)) {
        const secrets = keys.filter((key) => isSecret(key, vars[key] ?? ''));
        return {
            ok: true,
            file: t.target.label,
            changed: true,
            keys,
            gitTracked: true,
            warning:
                `${t.target.label} is TRACKED by git, so adding it to .gitignore does not protect it` +
                (secrets.length
                    ? ` — and this update wrote ${secrets.join(', ')} into it. Run \`git rm --cached ${t.target.label}\` to stop committing it.`
                    : '. Run `git rm --cached ' + t.target.label + '` to stop committing it.'),
        };
    }
    return { ok: true, file: t.target.label, changed: true, keys };
}

/** Presence (default) or value lookup of a key in the resolved `.env`, with the
 *  secret obfuscation safety default. */
export function applyCheckEnv(workspaceRoot: string, req: CheckEnvRequest): CheckEnvResult {
    if (!isValidEnvKey(req.key)) {
        return { ok: false, error: `invalid env key '${req.key}'` };
    }
    const t = resolveEnvTarget(workspaceRoot, req.target);
    if (!t.ok) return { ok: false, error: t.error };
    const map = parseEnv(readFileOrEmpty(t.target.path));
    const exists = map.has(req.key);
    const result: CheckEnvResult = { ok: true, exists, file: t.target.label };
    if (!exists) return result;
    const raw = map.get(req.key) ?? '';
    const secret = isSecret(req.key, raw);
    result.isSecret = secret;
    if (req.value) {
        if (secret && !req.force) {
            result.value = obfuscateSecret(raw);
            result.obfuscated = true;
        } else {
            result.value = raw;
            result.obfuscated = false;
        }
    }
    return result;
}
