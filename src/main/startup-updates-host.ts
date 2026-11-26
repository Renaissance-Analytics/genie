import { runStartupUpdates, startupTasks, STARTUP_UPDATES_LIMIT_MS, type StartupUpdatesReport, type StartupUpdateTask } from '../core/startup-updates.js';
import { HOST_TOOLS } from '../core/toolchain.js';
import { PROVIDER_TOOL } from '../core/cli-repair.js';
import { providerName } from '../core/provider-health.js';
import type { FeaturePorts } from './feature-ipc.js';
import { writeStartupProgress } from './startup-updates-file.js';

/**
 * GENIE-HOST'S START, UPDATES FIRST (Tynn #1067) — the host-side half of core/startup-updates.ts. genie-host awaits this
 * before it composes hosting, opens its process book and flows, or serves a window (see its boot). The CLI updates are the
 * toolchain's own (`update`, the same Update a Toolchain row runs: the program the agents run, judged by the version after);
 * PHP's is php-live's `php.applyDue` on the same toolchain port, when this build has it. Progress goes to the file a waiting
 * window reads (startup-updates-file.ts) and every line to the lifecycle log.
 */

type Toolchain = NonNullable<FeaturePorts['toolchain']>;
type PhpApplyDue = (progress: (step: string | null) => void) => Promise<{ readonly updated: readonly string[]; readonly failed: readonly { readonly version: string; readonly reason: string }[] }>;

export interface StartupUpdatesHostInput {
    readonly runtime: string;
    readonly toolchain: Pick<Toolchain, 'update'> & { readonly php?: unknown };
    readonly check: Parameters<typeof startupTasks>[0]['check'];
    readonly fetchJson: (url: string) => Promise<unknown>;
    readonly log: (line: string) => void;
    readonly env: Readonly<Record<string, string | undefined>>;
    /** Safe mode (Tynn #386): nothing changes by itself; the updates wait for a normal start. */
    readonly safeMode: boolean;
}

/** A test machine's stand-in update that takes a known time (GENIE_TEST_STARTUP_UPDATE_MS), for the ordering and limit rows only. */
export function testStartupTask(env: Readonly<Record<string, string | undefined>>): StartupUpdateTask | null {
    const raw = env['GENIE_TEST_STARTUP_UPDATE_MS'];
    if (env['GENIE_TEST_MACHINE'] !== '1' || raw === undefined || !/^\d+$/.test(raw)) return null;
    const ms = Math.min(Number(raw), 600_000);
    return { label: 'Test update', run: (say) => new Promise((done) => { say('Waiting on purpose (GENIE_TEST_STARTUP_UPDATE_MS)'); setTimeout(() => done(`waited ${ms} ms`), ms); }) };
}

/** The limit: three minutes; a test machine may name another (GENIE_TEST_STARTUP_LIMIT_MS). */
export function startupLimitMs(env: Readonly<Record<string, string | undefined>>): number {
    const raw = env['GENIE_TEST_STARTUP_LIMIT_MS'];
    return env['GENIE_TEST_MACHINE'] === '1' && raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : STARTUP_UPDATES_LIMIT_MS;
}

const npmLatest = async (fetchJson: (url: string) => Promise<unknown>, pkg: string): Promise<string | null> => {
    const body = await fetchJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`);
    const version = (body as { version?: unknown } | null)?.version;
    return typeof version === 'string' ? version : null;
};

export async function applyStartupUpdates(input: StartupUpdatesHostInput): Promise<StartupUpdatesReport | null> {
    if (input.safeMode) { input.log('startup updates: skipped (safe mode)'); return null; }
    const test = testStartupTask(input.env);
    const applyDue = (input.toolchain.php as { applyDue?: PhpApplyDue } | undefined)?.applyDue;
    const providers = Object.entries(PROVIDER_TOOL).flatMap(([provider, tool]) => {
        const npmPackage = HOST_TOOLS.find((t) => t.name === tool)?.npmPackage;
        return npmPackage ? [{ provider, label: providerName(provider), npmPackage }] : [];
    });
    return runStartupUpdates({
        tasks: async () => (test ? [test] : startupTasks({
            providers,
            check: input.check,
            latest: (pkg) => npmLatest(input.fetchJson, pkg),
            update: (provider, progress) => input.toolchain.update(PROVIDER_TOOL[provider]!, undefined, progress),
            ...(applyDue ? { php: applyDue } : {}),
        })),
        progress: (state) => { try { writeStartupProgress(input.runtime, state); } catch (error) { input.log(`startup updates: progress not written: ${error instanceof Error ? error.message : String(error)}`); } },
        log: input.log,
        now: Date.now,
    }, startupLimitMs(input.env));
}
