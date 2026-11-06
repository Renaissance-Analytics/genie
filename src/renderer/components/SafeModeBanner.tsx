import type { SafeModeView } from '../../core/safe-mode.js';

export type SafeModeAnswer = { ok: true } | { ok: false; reason: string };
export type SafeModeKind = 'agent' | 'process' | 'site';

export interface SafeModeBannerProps {
    view: SafeModeView | null | undefined;
    agentName: (agentId: string) => string;
    clock?: (at: number) => string;
    onStart: (kind: SafeModeKind, id: string) => Promise<SafeModeAnswer>;
    onLeave: () => Promise<SafeModeAnswer>;
}

/** SAFE MODE'S BANNER (Tynn #386). Red first: renders nothing yet. */
export function SafeModeBanner(_props: SafeModeBannerProps) {
    return null;
}
