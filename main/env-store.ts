import fs from 'node:fs';
import path from 'node:path';
import {
    parseEnv,
    upsertEnvLine,
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
