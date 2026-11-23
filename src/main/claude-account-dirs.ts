import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeAccounts, ClaudeSharedSessionsError, type ClaudeSharedSessionsRefusal } from '@particle-academy/prism-acp';

/**
 * A CLAUDE ACCOUNT'S DIRECTORY, MADE READY (Tynn #1011). Each account Genie adds signs in to a configuration directory of its
 * own (credentials stay apart), and that directory's `projects` is a link to ONE session store, the default home's `projects`,
 * so a thread resumes under whichever account is active.
 *
 * MEASURED before it was built (scripts/probes/claude-shared-store-probe.sh, Claude Code 2.1.330 on the Linux test VM, Azure jobs
 * 1121-173755-fb8c72 and 1121-174416-6e0d49): a thread started under directory A resumed under B with its history; B's requests
 * carried B's credential only; B's run opened nothing under A (strace, with positive controls); a directory with a real
 * `projects` of its own could not resume it. `--resume` reads only `projects/`.
 *
 * prism-acp owns the linking (0.46.0 `claudeAccounts.prepare(configDir, { sharedSessions: true })`): only `projects`, a junction
 * on Windows and a directory symlink elsewhere, never replacing, merging or reading anything, refusing with a typed code. Genie
 * makes the store and the directory's parent (prepare creates neither) and says each refusal in its own words.
 */

/** Every refusal prism-acp's `prepare` can give, with Genie's words for it. The words name no path. */
const REFUSAL_WORDS: Readonly<Record<ClaudeSharedSessionsRefusal, string>> = {
    realFolder: 'This account already keeps its own conversation history, so it cannot share the others\'. Genie leaves that history exactly as it is.',
    linkedElsewhere: 'This account\'s conversation history already points somewhere else, so Genie leaves it as it is rather than replace it.',
    occupied: 'Something that is not a folder is where this account\'s conversation history goes, so Genie leaves it as it is.',
    unexpectedLink: 'This account\'s conversation history is linked although it was meant to be separate, so Genie will not use it as it is.',
    storeMissing: 'The shared conversation history Claude Code keeps could not be found, so this account cannot share it yet.',
    storeInvalid: 'The shared conversation history is not in a place Genie can link to, so this account cannot share it.',
    configDirInvalid: 'The folder for this account could not be made ready (it is not a folder, or it is Claude Code\'s own default one).',
    linkFailed: 'The system refused to link this account\'s conversation history to the shared one.',
};
export const SHARED_SESSIONS_REFUSALS = Object.keys(REFUSAL_WORDS) as readonly ClaudeSharedSessionsRefusal[];

export function sharedSessionsWords(code: ClaudeSharedSessionsRefusal): string {
    return REFUSAL_WORDS[code] ?? 'The folder for this account could not be made ready.';
}

export type PreparedAccountDir = { ok: true } | { ok: false; code: ClaudeSharedSessionsRefusal | 'unknown'; reason: string };

/** Make the account's directory ready, its history shared with `store`. Never throws: a refusal comes back with its words. */
export function prepareAccountDir(configDir: string, store: string): PreparedAccountDir {
    try {
        mkdirSync(store, { recursive: true });
        mkdirSync(dirname(configDir), { recursive: true });
        claudeAccounts.prepare(configDir, { sharedSessions: true, store });
        return { ok: true };
    } catch (error) {
        if (error instanceof ClaudeSharedSessionsError) return { ok: false, code: error.code, reason: sharedSessionsWords(error.code) };
        return { ok: false, code: 'unknown', reason: `The folder for this account could not be made ready: ${error instanceof Error ? error.message : String(error)}` };
    }
}

/** Claude Code's own default for `cleanupPeriodDays` (code.claude.com settings reference). */
export const CLAUDE_CLEANUP_DEFAULT_DAYS = 30;

/** The default account's `cleanupPeriodDays`, read as that ONE key: nothing else in its settings is kept or copied. */
function defaultCleanupDays(defaultHome: string): number {
    try {
        const value = (JSON.parse(readFileSync(join(defaultHome, 'settings.json'), 'utf8')) as Record<string, unknown>)?.['cleanupPeriodDays'];
        return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : CLAUDE_CLEANUP_DEFAULT_DAYS;
    } catch {
        return CLAUDE_CLEANUP_DEFAULT_DAYS;
    }
}

/**
 * ONE CLEANUP PERIOD FOR A SHARED STORE (prism-acp 0.46.0's caveat). Claude Code deletes transcripts older than
 * `cleanupPeriodDays` under `projects/` whichever account is active, so with a shared store the SHORTEST setting among the
 * accounts prunes everyone's. Each directory Genie made carries the default account's value (Claude Code's 30 when it sets
 * none), in that directory's own `settings.json`, whose other keys are kept as they are.
 */
export function syncCleanupPeriod(configDir: string, defaultHome: string): void {
    const days = defaultCleanupDays(defaultHome);
    const file = join(configDir, 'settings.json');
    let current: Record<string, unknown> = {};
    let text: string | null = null;
    try { text = readFileSync(file, 'utf8'); } catch { /* none yet: written fresh */ }
    if (text !== null) {
        let parsed: unknown;
        // A settings file that is not a JSON object is the person's to fix: never overwritten here.
        try { parsed = JSON.parse(text); } catch { return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        current = parsed as Record<string, unknown>;
    }
    if (current['cleanupPeriodDays'] === days) return;
    writeFileSync(file, `${JSON.stringify({ ...current, cleanupPeriodDays: days }, null, 2)}\n`, { mode: 0o600 });
}
