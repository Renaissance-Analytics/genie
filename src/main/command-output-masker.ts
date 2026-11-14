const MASK = '********';

/**
 * Publish only masked command output (#633), including credentials split over stdout/stderr chunks.
 * Keep only a suffix that could still become a known credential, bounded by the longest credential.
 * A shorter credential that prefixes a longer one waits too, so its longer suffix never leaks.
 * At completion, mask even an unfinished credential prefix rather than disclose a truncated value.
 * Instances belong to ONE command; nothing raw is passed to the publication callback.
 */
export function commandOutputMasker(secrets: readonly string[], publish: (data: string) => void): { write(data: string): void; finish(): void } {
    const byFirst = new Map<string, string[]>();
    for (const secret of [...new Set(secrets)].filter((value) => value !== '').sort((a, b) => b.length - a.length)) {
        const first = secret[0]!;
        const group = byFirst.get(first) ?? [];
        group.push(secret);
        byFirst.set(first, group);
    }
    let pending = '';
    let finished = false;

    const drain = (data: string, final: boolean) => {
        const input = pending + data;
        const parts: string[] = [];
        let cursor = 0;
        let plainFrom = 0;
        while (cursor < input.length) {
            const candidates = byFirst.get(input[cursor]!);
            if (!candidates) { cursor += 1; continue; }
            const remaining = input.length - cursor;
            const incomplete = candidates.some((secret) => secret.length > remaining && secret.startsWith(input.slice(cursor)));
            if (incomplete && !final) break;
            // Candidates are longest first. Matching is literal, never a regexp over a credential.
            const whole = candidates.find((secret) => input.startsWith(secret, cursor));
            if (whole !== undefined || (incomplete && final)) {
                parts.push(input.slice(plainFrom, cursor), MASK);
                cursor += incomplete && final ? remaining : whole!.length;
                plainFrom = cursor;
            } else cursor += 1;
        }
        parts.push(input.slice(plainFrom, cursor));
        pending = input.slice(cursor);
        const masked = parts.join('');
        if (masked !== '') publish(masked);
    };

    return {
        write: (data) => { if (!finished && data !== '') drain(data, false); },
        finish: () => {
            if (finished) return;
            finished = true;
            try { drain('', true); }
            finally { pending = ''; byFirst.clear(); }
        },
    };
}
