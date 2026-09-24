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
