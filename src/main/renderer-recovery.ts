/**
 * A WINDOW'S PAGE THAT DIES IS BROUGHT BACK (Tynn #386; the owner's black window, 2026-11-06: `process gone
 * type=renderer:index reason=oom`, main alive, nothing reloaded the page, 3.5 hours black). Not yet.
 */
export const RENDERER_RELOAD_MAX = 3;
export const RENDERER_RELOAD_WINDOW_MS = 10 * 60_000;

export interface RendererNotice {
    readonly at: number;
    /** Electron's reason: `oom`, `crashed`, `killed`, … */
    readonly reason: string;
    /** The page's last known working set, in MB; `null` = never sampled. */
    readonly rendererMb: number | null;
    /** How many times within the window of {@link RENDERER_RELOAD_WINDOW_MS}. */
    readonly reloads: number;
}

export interface RecoverableContents {
    on(event: 'render-process-gone', listener: (event: unknown, details: { reason?: string; exitCode?: number }) => void): unknown;
    reload(): void;
    loadURL(url: string): unknown;
    isDestroyed(): boolean;
}

export interface RendererRecoveryOptions {
    readonly contents: RecoverableContents;
    readonly now?: () => number;
    readonly rendererMb: () => number | null;
    readonly onReloaded: (notice: RendererNotice) => void;
    readonly onGaveUp: (notice: RendererNotice) => void;
    /** The plain page shown once the reloads are spent: Restart Genie, Send a crash report. */
    readonly errorPage: (notice: RendererNotice) => string;
    /** A reload that throws: the window made again. */
    readonly recreate?: () => void;
    readonly log?: (line: string) => void;
}

export function recoverRenderer(_options: RendererRecoveryOptions): void {
    // Not yet: the page stays dead (the red rows in test/renderer-recovery.test.ts).
}

/** The plain page shown once the reloads are spent. Not yet. */
export function rendererErrorPage(_notice: RendererNotice): string {
    return 'about:blank';
}
