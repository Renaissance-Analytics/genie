import type { JsonObject, McpToolResult } from '@particle-academy/prism-mcp';
import { builtinToolDefinition, declareBuiltinTool, type BuiltinTool } from './builtin-tool.js';
import { callerFrom } from './mcp-callers.js';
import { MIRRORED_TERMINAL_ID, type Caller, type McpCall, type Registration } from './mcp-tools.js';
import type { PlaywrightInstallOutcome } from './playwright-browsers.js';

/**
 * `playwright` — WHAT GENIE HAS FOR PLAYWRIGHT, AND ASKING IT FOR A VERSION (Tynn #846). Agents never install browsers
 * themselves (`playwright install` downloads its own copy per machine user, per worktree); they read what Genie has and ask
 * Genie for what is missing. `status` asks nobody. `install` of a version's Chromium is Genie's own toolchain and runs at
 * once; what is unusually large (another browser, or one more set past `MAX_AUTO_SETS`) waits for the person on the Deck.
 */

export const PLAYWRIGHT_INSTALL_ACTION = 'playwright.install';

export interface PlaywrightStatus {
    /** The stable channel: what Genie installs when nothing else is asked for. */
    readonly stable: string;
    /** The versions whose browsers are on disk, newest first, with the browsers each has. */
    readonly installed: ReadonlyArray<{ readonly version: string; readonly browsers: readonly string[] }>;
    /** Genie's browsers folder, or `null` while it holds no set (PLAYWRIGHT_BROWSERS_PATH is then not set). */
    readonly browsersPath: string | null;
    /** The version the caller's workspace pins (its lockfile), or `null`. */
    readonly project: string | null;
    /** The versions being installed now. */
    readonly installing: readonly string[];
    /** Whether Genie installs by itself here. */
    readonly autoInstall: boolean;
}

export interface PlaywrightToolPort {
    status(workspaceId: string): PlaywrightStatus;
    /** The versions on disk, and the browsers a version has. */
    ready(): readonly string[];
    held(version: string): readonly string[];
    /** Install through Genie's installer (one at a time; an install already running for the version is waited for). */
    install(version: string, browsers: readonly string[]): Promise<PlaywrightInstallOutcome>;
}

export interface PlaywrightToolDeps {
    readonly resolveCaller: (key: string) => Caller | null;
    readonly port: PlaywrightToolPort;
    readonly approve: (caller: Caller, action: typeof PLAYWRIGHT_INSTALL_ACTION, detail: string, call: McpCall | undefined) => Promise<'allowed' | 'denied'>;
}

const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });

export function playwrightTools(deps: PlaywrightToolDeps): Registration[] {
    const tool: Registration = {
        definition: builtinToolDefinition(PLAYWRIGHT_TOOL),
        handler: async (args: JsonObject, context) => {
            const caller = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof caller === 'string') return err(caller);
            return err('RED: inert stub');
        },
    };
    return [tool];
}

// ---------------------------------------------------------------- compiled declarations (ADF A2, Tynn #446)
// What this tool IS, as data: the catalog registers it (main/genie-catalog.ts); the factory above binds its handler.
export const PLAYWRIGHT_TOOL: BuiltinTool = declareBuiltinTool(
    'playwright',
    'Genie’s Playwright browsers — one install for every workspace and worktree. Never run `playwright install` yourself. '
        + '`status` — the stable version, the versions Genie has (with their browsers), Genie’s browsers folder (PLAYWRIGHT_BROWSERS_PATH once a set is there), the version this workspace’s lockfile pins, and what is being installed now. '
        + '`install` {version, browsers?} — ask Genie for a version’s browsers (default chromium): it installs them at once and answers when they are there. Another browser (firefox, webkit), or one set more than Genie keeps by itself, waits for the person to approve it on the Deck. '
        + 'Use the version GENIE_PLAYWRIGHT_VERSION names for @playwright/test, so the browsers match.',
    {
        type: 'object',
        properties: {
            terminalId: MIRRORED_TERMINAL_ID,
            action: { type: 'string', enum: ['status', 'install'] },
            version: { type: 'string', description: 'install: the Playwright version, x.y.z (the one your @playwright/test is).' },
            browsers: { type: 'array', items: { type: 'string', enum: ['chromium', 'firefox', 'webkit'] }, description: 'install: which browsers (default chromium).' },
        },
        required: ['action'],
    },
    'Playwright'
);
/** This module's tools, in the order its factory returns them. */
export const PLAYWRIGHT_TOOLS: readonly BuiltinTool[] = [PLAYWRIGHT_TOOL];
