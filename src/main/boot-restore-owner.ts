/** Skeleton (the red run): who restores the agents at boot. */
export function restoresAtBoot(side: 'host' | 'window', _env: Readonly<Record<string, string | undefined>>): boolean {
    return side === 'window';
}
