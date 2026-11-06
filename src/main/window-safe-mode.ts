import type { SafeModeView } from '../core/safe-mode.js';
import type { SafeMode } from './safe-mode-host.js';

export type SafeModeAnswer = { ok: true } | { ok: false; reason: string };

/** What the window reads of genie-host's safe mode over the link (session-engine-client.ts). */
export interface LinkSafeMode {
    safeModeView(): SafeModeView | null;
    leaveSafeMode(): Promise<SafeModeAnswer>;
    onSafeMode(listener: (view: SafeModeView) => void): () => void;
}

/**
 * SAFE MODE AS THE WINDOW READS IT (Tynn #386). Red first: the shape only.
 */
export class WindowSafeMode {
    static open(_p: { readonly link: LinkSafeMode | null; readonly runtimeDir: string; readonly log?: (line: string) => void; readonly now?: () => number; readonly pid?: number }): WindowSafeMode {
        return new WindowSafeMode();
    }

    active(): boolean { return false; }
    view(): SafeModeView | null { return null; }
    async leave(): Promise<SafeModeAnswer> { return { ok: false, reason: 'not built yet' }; }
    onChange(_listener: (view: SafeModeView) => void): () => void { return () => {}; }
    own(): SafeMode | null { return null; }
    beat(_agents: readonly string[]): void {}
    endCleanly(_reason: string): void {}
}
