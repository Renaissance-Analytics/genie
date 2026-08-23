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
 * Append `.env` to a directory's `.gitignore` when absent (a `.env` carries
 * secrets — never commit it). Best-effort, mirroring ensureMcpGitignored.
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
        const lines = content.split(/\r?\n/).map((l) => l.trim());
        if (lines.includes('.env')) return;
        const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
        const block = `${prefix}\n# Genie: .env carries secrets (e.g. the Tynn agent token) — never commit it.\n.env\n`;
        fs.writeFileSync(file, content + block);
    } catch {
        /* best-effort */
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
        fs.writeFileSync(t.target.path, next);
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
        fs.writeFileSync(t.target.path, after);
    } catch (e) {
        return {
            ok: false,
            error: `write failed: ${e instanceof Error ? e.message : String(e)}`,
            file: t.target.label,
            changed: false,
            keys: [],
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
