/** Interpret only documented exit values; an unknown status is not a diagnosis. */
export function describeHostExit(code: number | null, signal: string | null): string {
    if (signal) return `killed by signal ${signal}`;
    if (code === 0) return 'clean exit 0';
    if (code === null) return 'UNKNOWN (no exit code or signal)';
    const status = code >>> 0;
    const hex = `0x${status.toString(16).toUpperCase().padStart(8, '0')}`;
    const known: Record<number, string> = {
        [0xc0000005]: 'access violation',
        [0xc0000409]: 'fail-fast/stack overrun',
        [0xc000013a]: 'close/Ctrl-C',
    };
    return `${hex} ${known[status] ?? 'UNKNOWN'}`;
}

/** Allowlist metadata: never serialize command arguments, environment or prompts. */
export function formatHostSpawnRequest(request: { id: string; provider?: string; label?: string }): string {
    return `pty spawn request ${JSON.stringify({
        id: request.id, provider: request.provider ?? 'shell', label: request.label ?? null,
    })}`;
}

/**
 * A pty that ENDED — the half of the breadcrumb that was missing.
 *
 * `formatHostSpawnRequest` recorded every attempt to start something and nothing
 * about how it went, so a process that could not start left one line per try and
 * no reason. That is how three workers restarted 9,306 times over five days and
 * read, in the log, as ordinary activity: the file said "started" nine thousand
 * times and never once said "and then it died, like this".
 *
 * `lifetimeMs` is the field that makes a loop legible at a glance. A service
 * that ran for hours and exited is a different event from one that died in 200ms,
 * and until now the log could not tell them apart.
 *
 * Same allowlist as the spawn line: identity and outcome only. Never the command,
 * its arguments, its environment or anything it printed.
 */
export function formatPtyExit(e: {
    id: string;
    label?: string | null;
    provider?: string | null;
    exitCode: number | null;
    signal?: string | number | null;
    lifetimeMs?: number | null;
}): string {
    const signal = e.signal === undefined || e.signal === null ? null : String(e.signal);
    return `pty exited ${JSON.stringify({
        id: e.id,
        provider: e.provider ?? 'shell',
        label: e.label ?? null,
        code: e.exitCode,
        signal,
        lifetimeMs: e.lifetimeMs ?? null,
    })} ${describeHostExit(e.exitCode, signal)}`;
}
