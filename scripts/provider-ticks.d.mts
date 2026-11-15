export interface ProviderTick { readonly pid: number; readonly generation: string; readonly bornAt: number; readonly tick: number }
export type ProviderGeneration = Omit<ProviderTick, 'tick'>;
export function providerTickLine(tick: number, provider: ProviderGeneration): string;
export function providerTicks(rows: unknown): ProviderTick[];
export function freshProviderGauge(options: { startedAt: number; before: readonly ProviderTick[] }): {
    observe(reading: { running: boolean; ticks: readonly ProviderTick[] }, alive: (pid: number) => boolean): ProviderTick | null;
    diagnostics(): { reason: string; startedAt: number; ticks: readonly ProviderTick[] };
};
