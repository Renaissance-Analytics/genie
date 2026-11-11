/** Red stub (beta.61 blocker, step five): a window whose link to a host dropped does not dial again. */
export function redialer(_input: { dial: () => Promise<boolean>; schedule: (ms: number, fn: () => void) => () => void; delay: (attempt: number) => number }): { dropped(): void; stop(): void } {
    return { dropped: () => {}, stop: () => {} };
}
