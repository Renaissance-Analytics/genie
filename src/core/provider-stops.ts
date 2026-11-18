/** Tynn #859 — RED stub: the table and the words are not written yet. */

export interface ProviderStopEntry {
    readonly provider: string;
    readonly documented: boolean;
    readonly meaning: string;
    readonly todo: string;
}

export interface ProviderStop {
    readonly code: string;
    readonly documented: boolean;
    readonly meaning: string;
    readonly todo: string;
    readonly providerMessage: string | null;
    readonly words: string;
}

export const KNOWN_PROVIDER_STOPS: Readonly<Record<string, ProviderStopEntry>> = {};

export function explainProviderStop(code: string, providerMessage: string | null = null): ProviderStop {
    return { code, documented: false, meaning: '', todo: '', providerMessage, words: code };
}

export function providerStopNote(_stop: ProviderStop, _count: number): string {
    return '';
}
