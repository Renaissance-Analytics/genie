/** What an update offers of genie-host, from its release feed (Tynn #413). Not built yet: the red commit's stand-in. */
export interface OfferedHost {
    readonly hostHash?: string | null | undefined;
    readonly engineProtocol?: number | null | undefined;
}

export interface RunningHost {
    readonly build: string;
    readonly protocol: number;
}

export type UpdateScope = { readonly kind: 'client-only' } | { readonly kind: 'full'; readonly why: string };

export function hostHashOf(_build: string): string | null {
    return null;
}

export function classifyUpdate(_offered: OfferedHost, _running: RunningHost | null | undefined): UpdateScope {
    return { kind: 'full', why: 'not built yet' };
}
