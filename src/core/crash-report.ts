import type { SafeModeView } from './safe-mode.js';

/**
 * A CRASH REPORT THE PERSON CHOOSES TO SEND (Tynn #386 part 4; spec .ai/plans/genie-crash-safe-mode-reporting-spec.md
 * §4). Never automatic: the safe-mode banner offers it, shows the EXACT text, lets the person edit it and say what they
 * were doing, and sends only on Send (to Tynn, which redacts again by the same rules and files it on fow-support).
 *
 * What the PUBLIC report takes from the crash record (cut 3, src/core/crash-record.ts — local, and full of private
 * things): the kind and time, the header (version, os, arch, uptime), stall statistics per stack SIGNATURE (count, max and
 * total ms), memory as a bucketed series, the agent COUNT and providers, the last tools' sizes in buckets, an exit's reason
 * and code, and an error's message after redaction. NEVER the lifecycle lines, a stall's route (genie://Workspace/agent),
 * an agent's name or its last tool's name.
 */

export interface StallStat {
    readonly signature: string;
    readonly count: number;
    readonly maxMs: number;
    readonly totalMs: number;
}

export interface CrashFacts {
    readonly view: SafeModeView;
    readonly genieVersion: string;
    readonly os: string;
    readonly arch: string;
    /** The OS release from the record's header (`6.12`, `10.0.26200`), when known. */
    readonly osRelease?: string;
    /** How long the run that ended had been up, when known. */
    readonly uptimeMs?: number | null;
    /** One entry per agent that was running: its provider. */
    readonly providers: readonly string[];
    /** Each agent ledger's size in bytes (shown in buckets). */
    readonly ledgerBytes?: readonly number[];
    /** A stall summary with raw frames (signatures are made from them). */
    readonly stall?: { readonly count: number; readonly worstMs: number; readonly stacks: readonly string[] } | null;
    /** Stalls per stack signature (from the crash record). */
    readonly stallStats?: readonly StallStat[];
    /** Memory samples (MB), oldest first: shown bucketed. */
    readonly memoryMb?: readonly number[];
    /** The running agents' last tools' sizes (bytes): shown bucketed. */
    readonly toolBytes?: readonly number[];
    /** An exit's reason and code. */
    readonly exit?: { readonly reason: string; readonly code: number | null } | null;
    /** An error's message — redacted with the rest. */
    readonly error?: string | null;
}

export interface RedactionContext {
    readonly workspaceNames: readonly string[];
    readonly agentNames: readonly string[];
}

const MB = 1024 * 1024;

function duration(ms: number): string {
    const m = Math.floor(ms / 60_000);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function sizeBucket(bytes: number): string {
    if (bytes < MB) return '<1 MB';
    if (bytes < 10 * MB) return '1-10 MB';
    if (bytes < 100 * MB) return '10-100 MB';
    return '>100 MB';
}

function memoryBucket(mb: number): string {
    if (mb < 500) return '<500 MB';
    if (mb < 1024) return '500 MB-1 GB';
    if (mb < 2048) return '1-2 GB';
    if (mb < 4096) return '2-4 GB';
    return '>4 GB';
}

const counted = (values: readonly string[]) => {
    const n = new Map<string, number>();
    for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
    return [...n].map(([k, c]) => `${k} ×${c}`).join(', ');
};

/**
 * A stack frame as a signature: its function name and its module RELATIVE TO THE APP (from `dist/`, `src/` or inside
 * `app.asar`), without the line and column. A frame outside the app keeps its function name only.
 */
export function stackSignature(frame: string): string {
    const line = frame.trim().replace(/^at\s+/, '');
    const m = /^(.*?)\s*\((.*)\)$/.exec(line);
    const fnName = m ? m[1]!.trim() : '';
    const where = (m ? m[2]! : line).replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '');
    const inApp = /(?:app\.asar\/|resources\/app\/|\/|^)((?:dist|src|out)\/.+)$/.exec(where);
    const module = inApp ? inApp[1]! : '';
    if (fnName && module) return `${fnName} (${module})`;
    return fnName || module || '(anonymous)';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** cut 3's frame shape (core/crash-record.ts on next/hang-watchdog): a function name, then `file:line` when it has one. */
const RECORD_FRAME = /^[A-Za-z0-9_$.<>()[\]# -]{1,120}( [A-Za-z0-9_.-]{1,120}:[0-9]{1,7})?$/;
const RECORD_FRAMES = 12;

/**
 * A stall's stack in a crash record is ALREADY a signature (`drawLane WorkspaceDashboard.js:88 < paint main.js:5023`): it is
 * kept whole, at most 12 frames, and a frame that is not of that shape is `?` here too, whatever wrote the record.
 */
function recordSignature(stack: string): string {
    return stack.split(' < ').slice(0, RECORD_FRAMES).map((frame) => (RECORD_FRAME.test(frame.trim()) ? frame.trim() : '?')).join(' < ');
}

/**
 * THE CRASH RECORD, AS THE PUBLIC REPORT MAY TAKE IT (cut 3's CrashRecord: hang | lost | exit, with a header). Reads only
 * the allowed fields; lifecycle lines, routes, agent names and tool names are never read.
 */
export function factsFromRecord(record: unknown, base: { view: SafeModeView; providers: readonly string[]; genieVersion?: string; os?: string; arch?: string }): CrashFacts {
    const r = isRecord(record) ? record : {};
    // CrashRecord = CrashHeader & (hang | lost | exit): the header's fields are on the record itself.
    const header = r;
    const stalls = Array.isArray(r['stalls']) ? r['stalls'] : [];
    const bySignature = new Map<string, { count: number; maxMs: number; totalMs: number }>();
    for (const s of stalls) {
        if (!isRecord(s)) continue;
        const ms = num(s['ms']) ?? 0;
        const signature = typeof s['stack'] === 'string' && s['stack'] !== '' ? recordSignature(s['stack']) : '(no stack)';
        const stat = bySignature.get(signature) ?? { count: 0, maxMs: 0, totalMs: 0 };
        bySignature.set(signature, { count: stat.count + 1, maxMs: Math.max(stat.maxMs, ms), totalMs: stat.totalMs + ms });
    }
    const memory = (Array.isArray(r['memory']) ? r['memory'] : []).flatMap((m) => (isRecord(m) ? [num(m['windowMb']) ?? num(m['hostMb'])].filter((x): x is number => x !== null) : []));
    const agents = Array.isArray(r['agents']) ? r['agents'] : [];
    const toolBytes = agents.flatMap((a) => (isRecord(a) && num(a['lastToolBytes']) !== null ? [num(a['lastToolBytes'])!] : []));
    const kind = typeof r['kind'] === 'string' ? r['kind'] : base.view.cause;
    const uptimeS = num(header['uptimeS']);
    return {
        view: { ...base.view, cause: kind },
        genieVersion: typeof header['version'] === 'string' ? header['version'] : base.genieVersion ?? 'unknown',
        os: typeof header['os'] === 'string' ? header['os'] : base.os ?? 'unknown',
        arch: typeof header['arch'] === 'string' ? header['arch'] : base.arch ?? 'unknown',
        ...(typeof header['osRelease'] === 'string' && header['osRelease'] !== 'unknown' ? { osRelease: header['osRelease'] } : {}),
        uptimeMs: uptimeS === null ? null : uptimeS * 1000,
        providers: agents.length > 0 && base.providers.length === 0 ? agents.map(() => 'unknown') : base.providers,
        stallStats: [...bySignature].map(([signature, s]) => ({ signature, ...s })).sort((a, b) => b.totalMs - a.totalMs),
        ...(memory.length > 0 ? { memoryMb: memory } : {}),
        ...(toolBytes.length > 0 ? { toolBytes } : {}),
        ...(kind === 'exit' ? { exit: { reason: typeof r['reason'] === 'string' ? r['reason'] : 'unknown', code: num(r['code']) } } : {}),
        ...(typeof r['error'] === 'string' ? { error: r['error'] } : {}),
    };
}

/** The report's text: what the person sees, edits and sends (redacted by the caller with {@link redactCrashText}). */
export function crashReportText(f: CrashFacts): string {
    const providers = counted(f.providers);
    const lines = [
        'Genie crash report',
        `Kind: ${f.view.cause}${f.view.crashLoop ? ' (crash loop)' : ''}`,
        `Genie ${f.genieVersion} on ${f.os}${f.osRelease ? ` ${f.osRelease}` : ''} ${f.arch}`,
        ...(f.uptimeMs ? [`Uptime: ${duration(f.uptimeMs)}`] : []),
        `Agents: ${f.providers.length} agent${f.providers.length === 1 ? '' : 's'}${providers ? ` (${providers})` : ''}`,
    ];
    if (f.exit) lines.push(`Exit: ${f.exit.reason}${f.exit.code === null ? '' : `, code ${f.exit.code}`}`);
    if (f.error) lines.push(`Error: ${f.error}`);
    if (f.ledgerBytes && f.ledgerBytes.length > 0) lines.push(`Ledger sizes: ${counted(f.ledgerBytes.map(sizeBucket))}`);
    if (f.toolBytes && f.toolBytes.length > 0) lines.push(`Last tool sizes: ${counted(f.toolBytes.map(sizeBucket))}`);
    if (f.memoryMb && f.memoryMb.length > 0) lines.push(`Memory: ${f.memoryMb.map(memoryBucket).join(' → ')}`);
    const stats = f.stallStats ?? [];
    if (stats.length > 0) {
        const count = stats.reduce((n, s) => n + s.count, 0);
        const worst = Math.max(...stats.map((s) => s.maxMs));
        lines.push(`Stalls: ${count} stall${count === 1 ? '' : 's'}, the worst ${Math.round(worst / 1000)} s`);
        lines.push('', 'Stalls by stack signature:', ...stats.slice(0, 10).map((s) => `  ${s.signature}: ${s.count}×, max ${Math.round(s.maxMs / 1000)} s, total ${Math.round(s.totalMs / 1000)} s`));
    } else if (f.stall) {
        lines.push(`Stalls: ${f.stall.count} stalls, the worst ${Math.round(f.stall.worstMs / 1000)} s`);
        const signatures = f.stall.stacks.slice(0, 10).map(stackSignature);
        if (signatures.length > 0) lines.push('', 'Top stack signatures:', ...signatures.map((s) => `  ${s}`));
    }
    return lines.join('\n');
}

/** The top stack signatures, as the report sends them (Tynn fingerprints on them). */
export function crashSignatures(f: CrashFacts): string[] {
    if (f.stallStats && f.stallStats.length > 0) return f.stallStats.slice(0, 10).map((s) => s.signature);
    return (f.stall?.stacks ?? []).slice(0, 10).map(stackSignature);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CODE_FILE = /[\\/]([^\\/]+\.(?:[cm]?js|tsx?|jsx))(:\d+(?::\d+)?)?$/;
const pathOut = (match: string): string => {
    const c = CODE_FILE.exec(match);
    return c ? `${c[1]}${c[2] ?? ''}` : '[path]';
};

/**
 * THE CLIENT'S REDACTION PASS — the SAME rules, in the same order, as Tynn's (app/Services/Genie/CrashReportRedactor.php);
 * both are checked against test/fixtures/crash-redaction.json. Genie also knows its agents' names ([agent]). A second
 * pass changes nothing.
 */
export function redactCrashText(text: string, ctx: RedactionContext): string {
    let out = text;
    const named = (names: readonly string[], placeholder: string) => {
        const list = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
        for (const n of list) out = out.replace(new RegExp(`(?<![\\w-])${escape(n)}(?![\\w-])`, 'giu'), placeholder);
    };
    named(ctx.workspaceNames, '[workspace]');
    named(ctx.agentNames, '[agent]');
    const rules: Array<[RegExp, string]> = [
        [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[secret]'],
        [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[secret]'],
        [/\bsk-[A-Za-z0-9_-]{16,}/g, '[secret]'],
        [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[secret]'],
        [/\bAKIA[0-9A-Z]{16}\b/g, '[secret]'],
        [/\b[A-Fa-f0-9]{32,}\b/g, '[secret]'],
        [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
        [/\b(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+\.(?:gen|local|internal|lan|ts\.net)\b[^\s)]*/gi, '[private-host]'],
        [/\b(?:https?:\/\/)?(?:localhost|(?:10\.\d{1,3}|127\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?::\d+)?[^\s)]*/gi, '[private-host]'],
        [/\bhttps?:\/\/[^\s)]+/gi, '[url]'],
    ];
    for (const [pattern, placeholder] of rules) out = out.replace(pattern, placeholder);
    // Absolute paths: UNC, drive-letter (either slash), POSIX. A code file keeps its name and line.
    out = out.replace(/\\\\[^\s\\]+\\[^\s"'<>|)]*/g, pathOut);
    out = out.replace(/(?<![\w])[A-Za-z]:[\\/][^\s"'<>|)]*/g, pathOut);
    out = out.replace(/(?<![\w.:/\]\\])\/(?:[^\s/"'<>)]+\/)*[^\s/"'<>)]+/g, pathOut);
    // @mentions, in backticks: a public issue notifies nobody.
    return out.replace(/(?<![\w`])@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![\w`-])/g, '`@$1`');
}

/**
 * WHAT IS SENT IS WHAT THE PERSON SAW: text that redaction leaves as it is goes as written; text it would change is not
 * sent — the cleaned version comes back to be looked at again.
 */
export function checkBeforeSend(text: string, ctx: RedactionContext): { ok: true; text: string } | { ok: false; text: string; reason: string } {
    const clean = redactCrashText(text, ctx);
    if (clean === text) return { ok: true, text };
    return { ok: false, text: clean, reason: 'Genie removed private details from the report. Check it, then Send again.' };
}
