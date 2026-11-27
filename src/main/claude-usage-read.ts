import { mkdirSync } from 'node:fs';
import { ClaudeDriver } from '@particle-academy/prism-acp';
import { RATE_LIMIT_META, headroomFromMeta, type Headroom } from '../core/headroom.js';

/** The model the usage probe asks with (Tynn #1084): the cheapest. */
export const USAGE_PROBE_MODEL = 'haiku';
/** What it asks: one word back, so the turn costs as little as a turn can. */
export const USAGE_PROBE_PROMPT = 'Reply with the single word OK.';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ClaudeUsageReadOptions {
    /** The account's folder (CLAUDE_CONFIG_DIR), or `null` for Claude Code's own default home. */
    readonly configDir: string | null;
    /** An empty folder of the probe's own: nothing of a workspace is in reach, and no project's history gains a session. */
    readonly cwd: string;
    readonly binary?: string;
    readonly binaryArgs?: readonly string[];
    readonly parentEnv?: Readonly<Record<string, string | undefined>>;
    readonly allowEnv?: readonly string[];
    readonly timeoutMs?: number;
}

/**
 * READ A CLAUDE ACCOUNT'S USAGE WITH NO AGENT (Tynn #1084). Claude Code reports an account's limits only in a turn (its
 * `rate_limit_event`, which prism-acp hands on as the rate-limit `_meta` every agent reading already comes from), and
 * prism-acp 0.48.0's ClaudeDriver has no turn-free read. So this is one tiny turn in THAT account's folder:
 *  - the cheapest model, one turn, a one-word prompt;
 *  - no tools (`--tools ""`), no MCP (strict, with none), no user/project settings (so no hooks or plugins);
 *  - nothing kept in the session history (`--no-session-persistence`), run from an empty folder of its own;
 *  - it is not an agent: no record, no ledger, no row anywhere.
 * Genie reads no credential: Claude Code signs the request with the account's own login, as it does for any agent. It
 * resolves with the first reading the turn reports, and rejects, saying why, when the turn reports none, the CLI ends, or it
 * does not answer in time. The process is always stopped.
 *
 * prism-acp's `nativeTools: 'none'` is not used: it is measured against one exact CLI version (2.1.311) and refuses any other.
 */
export function readClaudeUsage(options: ClaudeUsageReadOptions): Promise<Headroom> {
    mkdirSync(options.cwd, { recursive: true });
    return new Promise<Headroom>((resolve, reject) => {
        let settled = false;
        let driver: ClaudeDriver | null = null;
        // What the turn did say, for a failure's words: a notice's text, or why a frame was not mapped.
        const said: string[] = [];
        const finish = (outcome: { room: Headroom } | { error: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { driver?.kill(); } catch { /* already gone */ }
            if ('room' in outcome) resolve(outcome.room); else reject(new Error(outcome.error));
        };
        const timer = setTimeout(() => finish({ error: 'Claude Code did not answer in time' }), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        try {
            driver = new ClaudeDriver({
                cwd: options.cwd,
                configDir: options.configDir,
                model: USAGE_PROBE_MODEL,
                strictMcpConfig: true,
                settingSources: [],
                ...(options.binary !== undefined ? { binary: options.binary } : {}),
                binaryArgs: [...(options.binaryArgs ?? []), '--tools', '', '--max-turns', '1', '--no-session-persistence'],
                ...(options.parentEnv !== undefined ? { parentEnv: options.parentEnv } : {}),
                ...(options.allowEnv !== undefined ? { allowEnv: options.allowEnv } : {}),
            }, {
                onUpdate: (update) => {
                    const u = update as Record<string, unknown>;
                    const meta = u['_meta'];
                    const notice = u['notice'];
                    if (typeof notice === 'object' && notice !== null && typeof (notice as Record<string, unknown>)['message'] === 'string') said.push(String((notice as Record<string, unknown>)['message']).slice(0, 160));
                    const unmapped = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)['particle.academy/unmapped_frame'] : undefined;
                    if (typeof unmapped === 'object' && unmapped !== null && typeof (unmapped as Record<string, unknown>)['reason'] === 'string') said.push(String((unmapped as Record<string, unknown>)['reason']).slice(0, 160));
                    if (typeof meta !== 'object' || meta === null || !(RATE_LIMIT_META in meta)) return;
                    const room = headroomFromMeta((meta as Record<string, unknown>)[RATE_LIMIT_META]);
                    if (room) finish({ room });
                },
                // The reading comes before the turn's result; a turn that ends without one reported none.
                onTurnEnd: (outcome) => {
                    const why = outcome.isError ? ` (the turn failed${outcome.failure ? `: ${JSON.stringify(outcome.failure).slice(0, 200)}` : ''})` : said.length > 0 ? ` (it said: ${said.join(' | ')})` : '';
                    setTimeout(() => finish({ error: `Claude Code reported no usage for this account${why}` }), 0);
                },
                onExit: () => { setTimeout(() => finish({ error: 'Claude Code ended before it reported this account\'s usage' }), 0); },
                onProtocolError: (problem) => finish({ error: `Claude Code could not be asked: ${problem}` }),
            });
            driver.start();
            driver.prompt(USAGE_PROBE_PROMPT);
        } catch (error) {
            finish({ error: `Claude Code could not be asked: ${error instanceof Error ? error.message : String(error)}` });
        }
    });
}
