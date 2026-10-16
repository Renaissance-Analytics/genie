/**
 * RETRY — a few attempts with doubling waits, for a download the build cannot do without.
 *
 * A network reset in CI (`fetch failed … read ECONNRESET`) failed a packaging job that would have
 * passed a second later. Every retry is reported through `onRetry` so a build that limped through
 * says so in its log; when every attempt fails the LAST error is thrown unchanged.
 */

export interface RetryOptions {
    readonly attempts: number;
    readonly delayMs: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onRetry?: (error: unknown, attempt: number) => void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
    if (!Number.isInteger(options.attempts) || options.attempts < 1) throw new Error(`retry: attempts must be a positive integer, got ${options.attempts}`);
    const sleep = options.sleep ?? wait;
    let lastError: unknown;
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt === options.attempts) break;
            options.onRetry?.(error, attempt);
            await sleep(options.delayMs * 2 ** (attempt - 1));
        }
    }
    throw lastError;
}
