/**
 * VM ONLY: Tynn runs this on omarchy-test, never on the owner's desktop.
 * One tiny real turn per provider; artifacts retain RAW notices, not reconstructed fixtures.
 * Explicit CLI only. Importing this module constructs no driver and starts no provider.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeDriver, CodexDriver, type StopVerdict } from '@particle-academy/prism-acp';
import { headroomFromMeta, RATE_LIMIT_META } from '../../src/core/headroom.js';
import type { DriverEvents, TurnOutcomeLike } from '../../src/core/session.js';

type Provider = 'claude' | 'codex';
interface CaptureDriver {
    start(): void;
    readonly ready?: Promise<void>;
    prompt(text: string): void;
    stop(options?: { graceMs?: number }): Promise<StopVerdict>;
}
interface CaptureOptions {
    directory: string;
    createDriver: (provider: Provider, cwd: string, events: DriverEvents) => CaptureDriver;
    timeoutMs?: number;
    settleMs?: number;
}
interface CaptureReport {
    provider: Provider; sent: number; turns: number; notices: number; noticeBytes: number;
    outcome: TurnOutcomeLike | null; stop: StopVerdict | null; failures: string[]; file: string;
}
const PROMPT = 'Reply only OK. Do not use any tools.';
const delay = (ms: number) => new Promise<void>(resolveWait => setTimeout(resolveWait, ms));
const shortError = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Injectable drivers keep unit tests inert. Only the explicit CLI supplies real authenticated drivers. */
export async function captureRateLimitTurns(options: CaptureOptions) {
    const timeoutMs = options.timeoutMs ?? 120_000, settleMs = options.settleMs ?? 250;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000 || !Number.isFinite(settleMs) || settleMs < 0 || settleMs > 1000) throw new Error('invalid capture deadlines');
    await mkdir(options.directory, { recursive: true });
    const root = await mkdtemp(join(options.directory, 'work-'));
    const reports: CaptureReport[] = [], failures: string[] = [];
    let unsafeCleanup = false;
    try {
        for (const provider of ['claude', 'codex'] as const) {
            const cwd = join(root, provider); await mkdir(cwd);
            const report: CaptureReport = { provider, sent: 0, turns: 0, notices: 0, noticeBytes: 0, outcome: null, stop: null, failures: [], file: join(options.directory, `${provider}.json`) };
            const fail = (reason: string) => { if (report.failures.length < 16 && !report.failures.includes(reason)) report.failures.push(reason); };
            const notices: Record<string, unknown>[] = [];
            let finish!: () => void;
            const done = new Promise<void>(resolveDone => { finish = resolveDone; });
            let timedOut = false, exited = false, stopping = false, driver: CaptureDriver | null = null;
            const events: DriverEvents = {
                onUpdate: frame => {
                    const meta = frame._meta;
                    if (frame.sessionUpdate !== 'notice' || !meta || typeof meta !== 'object' || Array.isArray(meta) || !(RATE_LIMIT_META in meta)) return;
                    try {
                        const json = JSON.stringify(frame), bytes = Buffer.byteLength(json);
                        if (notices.length >= 64 || report.noticeBytes + bytes > 2 * 1024 * 1024) { fail('raw rate-limit notices exceeded the bounded capture budget'); return; }
                        notices.push(JSON.parse(json) as Record<string, unknown>); report.noticeBytes += bytes;
                    } catch (error) { fail(`raw notice serialization: ${shortError(error)}`); }
                },
                onTurnEnd: outcome => { report.turns++; report.outcome = outcome; finish(); },
                onExit: () => { exited = true; if (!stopping && report.turns === 0) { fail('provider exited before a turn completed'); finish(); } },
                onProtocolError: problem => { fail(`provider protocol: ${shortError(problem)}`); finish(); },
            };
            const timer = setTimeout(() => { timedOut = true; finish(); }, timeoutMs);
            try {
                driver = options.createDriver(provider, cwd, events);
                driver.start();
                await Promise.race([Promise.resolve(driver.ready), done]); // Read ready AFTER start.
                if (!timedOut && !exited && report.turns === 0 && report.failures.length === 0) { driver.prompt(PROMPT); report.sent = 1; }
                await done;
                if (timedOut) fail('provider turn timed out');
                if (!timedOut && settleMs) await delay(settleMs); // Capture a trailing limit notice without spending a second turn.
            } catch (error) { fail(`provider turn: ${shortError(error)}`); }
            finally {
                clearTimeout(timer); stopping = true;
                try { if (driver) report.stop = await driver.stop({ graceMs: 2000 }); }
                catch (error) { fail(`provider stop: ${shortError(error)}`); }
            }
            if (report.sent !== 1 || report.turns !== 1 || report.outcome?.isError || report.outcome?.stopReason !== 'end_turn') fail('one successful real turn was not completed');
            const stopped = report.stop?.empty === true && report.stop.verified === true && report.stop.survivors === 0;
            if (!stopped) { unsafeCleanup = true; fail('provider cleanup is unverified or survivors remain; second provider must not start'); }
            report.notices = notices.length;
            if (!notices.length) fail('no raw rate-limit notice was captured');
            else if (!notices.some(frame => headroomFromMeta((frame._meta as Record<string, unknown>)[RATE_LIMIT_META]) !== null)) fail('captured notices contain no recognized provider headroom');
            // Retain the entire original notice frame, including raw/provider-specific metadata, even on failure.
            await writeFile(report.file, JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), node: process.version, ...report, notices }, null, 2) + '\n', { flag: 'wx' });
            reports.push(report); failures.push(...report.failures.map(reason => `${provider}: ${reason}`));
            if (!stopped) break;
        }
    } finally {
        // The exact mkdtemp-owned root only. An unverified provider keeps its cwd for VM diagnosis.
        if (!unsafeCleanup) { try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(`capture fixture cleanup: ${shortError(error)}`); } }
    }
    const result = { version: 1, code: failures.length ? 1 : 0, reports, failures, unsafeCleanup, retainedWorkDirectory: unsafeCleanup ? root : null };
    await writeFile(join(options.directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
}

function realDriver(provider: Provider, cwd: string, events: DriverEvents): CaptureDriver {
    const callbacks = {
        onUpdate: (update: unknown) => events.onUpdate?.(update as Record<string, unknown>),
        onTurnEnd: (outcome: TurnOutcomeLike) => events.onTurnEnd?.(outcome),
        onExit: (code: number | null, signal: NodeJS.Signals | null) => events.onExit?.(code, signal),
        onRequestPermission: async () => ({ outcome: 'cancelled' as const }),
    };
    return provider === 'claude'
        ? new ClaudeDriver({ cwd, binary: process.env.GENIE2_CLAUDE_BINARY ?? 'claude', permissionMode: 'plan', mcpServers: [] }, callbacks)
        : new CodexDriver({ cwd, binary: process.env.GENIE2_CODEX_BINARY ?? 'codex', sandbox: 'read-only', approvalPolicy: 'untrusted', mcpServers: [] }, callbacks);
}

const entry = fileURLToPath(import.meta.url), launchedAs = process.argv[1] ? resolve(process.argv[1]) : '';
const samePath = process.platform === 'win32' ? entry.toLowerCase() === launchedAs.toLowerCase() : entry === launchedAs;
if (samePath) {
    try {
        const parent = resolve('artifacts', 'rate-limit-capture'); await mkdir(parent, { recursive: true });
        const directory = await mkdtemp(join(parent, 'run-'));
        const result = await captureRateLimitTurns({ directory, createDriver: realDriver });
        for (const report of result.reports) console.log(`rate-limit-capture provider=${report.provider} turns=${report.turns} notices=${report.notices} bytes=${report.noticeBytes} stopVerified=${report.stop?.verified === true} failures=${report.failures.length}`);
        console.log(`rate-limit-capture code=${result.code} failures=${result.failures.length} directory=${directory}`);
        process.exitCode = result.code;
        if (result.unsafeCleanup) process.exit(1); // Leave a bounded, failed VM job; never start a competing provider.
    } catch (error) { console.error(`rate-limit-capture failed: ${shortError(error)}`); process.exitCode = 1; }
}
