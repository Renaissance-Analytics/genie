/**
 * Stream publication boundary for #633. Tests-first seam only: NOT wired to the executor.
 * The implementation must withhold possible secret prefixes across chunk boundaries before publishing anything.
 */
export function commandOutputMasker(_secrets: readonly string[], publish: (data: string) => void): { write(data: string): void; finish(): void } {
    return { write: (data) => publish(data), finish: () => {} };
}
