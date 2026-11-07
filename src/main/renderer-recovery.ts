/**
 * A WINDOW'S PAGE THAT ENDS IS BROUGHT BACK (Tynn #386; the owner's machine, 2026-11-06 21:04:35: `process gone
 * type=renderer:index reason=oom exit=-536870904` — main lived on, nothing reloaded the page, and the window was a black
 * rectangle for 3.5 hours while the agents ran).
 *
 * Any end of the page but a clean exit reloads it — or, if the reload throws, the window is made again — at most
 * {@link RENDERER_RELOAD_MAX} times in {@link RENDERER_RELOAD_WINDOW_MS}, the hang relaunch's cap. Past that, a plain page
 * with Restart Genie and Send a crash report (its links are main's to answer: main.ts `will-navigate`), so the window is
 * never a dead black rectangle. Each reload leaves a notice for the window (when, why, the page's last known memory);
 * the crash record is the recorder's (window-crash-recorder.ts, with the same memory).
 */
import { rendererEndWords, type RendererNotice } from '../core/renderer-notice.js';

export type { RendererNotice } from '../core/renderer-notice.js';
export const RENDERER_RELOAD_MAX = 3;
export const RENDERER_RELOAD_WINDOW_MS = 10 * 60_000;
/** The error page's two links, answered by main. */
export const RECOVER_RESTART = 'genie-recover:restart';
export const RECOVER_REPORT = 'genie-recover:report';

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

export function recoverRenderer(o: RendererRecoveryOptions): void {
    const now = o.now ?? Date.now;
    let ends: number[] = [];
    o.contents.on('render-process-gone', (_event, details) => {
        try {
            const reason = typeof details?.reason === 'string' ? details.reason : 'unknown';
            if (reason === 'clean-exit' || o.contents.isDestroyed()) return;
            const at = now();
            ends = [...ends.filter((t) => at - t < RENDERER_RELOAD_WINDOW_MS), at];
            let mb: number | null = null;
            try { mb = o.rendererMb(); } catch { mb = null; }
            const notice: RendererNotice = { at, reason, rendererMb: mb, reloads: ends.length };
            if (ends.length > RENDERER_RELOAD_MAX) {
                o.log?.(`page ended reason=${reason} renderer_mb=${mb ?? '-'}: ${RENDERER_RELOAD_MAX} reloads within 10 min already; the window shows Restart Genie`);
                o.contents.loadURL(o.errorPage(notice));
                o.onGaveUp(notice);
                return;
            }
            try {
                o.contents.reload();
                o.log?.(`page ended reason=${reason} renderer_mb=${mb ?? '-'}: reloaded (${ends.length} of ${RENDERER_RELOAD_MAX} within 10 min)`);
            } catch (error) {
                o.log?.(`page ended reason=${reason} renderer_mb=${mb ?? '-'}: the reload failed (${error instanceof Error ? error.message : String(error)}); the window is made again`);
                o.recreate?.();
            }
            o.onReloaded(notice);
        } catch (error) {
            try { o.log?.(`page ended: bringing it back failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* nothing left */ }
        }
    });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The plain page once the reloads are spent: no script, no Genie code to fail again — two links main answers. Built as a
 * data URL, so it needs nothing from the page that kept dying.
 */
export function rendererErrorPage(notice: RendererNotice): string {
    const words = escapeHtml(rendererEndWords(notice.reason));
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Genie</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#16161a;color:#e8e8ea;font:14px system-ui,sans-serif}
main{max-width:460px;padding:24px;text-align:left}h1{font-size:18px;margin:0 0 8px}p{color:#b4b4bc;line-height:1.5}
a{display:inline-block;margin:12px 12px 0 0;padding:8px 14px;border-radius:6px;background:#2d2d36;color:#fff;text-decoration:none}a.primary{background:#5b5bd6}
</style></head><body><main data-renderer-error><h1>Genie's window ${words} again</h1>
<p>It was brought back ${RENDERER_RELOAD_MAX} times in 10 minutes, so it stopped trying. Your agents keep running in Genie's host.</p>
<a class="primary" href="${RECOVER_RESTART}" data-action="renderer-restart">Restart Genie</a><a href="${RECOVER_REPORT}" data-action="renderer-report">Send a crash report</a>
</main></body></html>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export interface PageMemorySampler {
    sample(): void;
    loaded(): void;
    bytes(): number | null;
    mb(): number | null;
}

/** The page's working set as last read. Not yet: whatever the last reading was, 0 included. */
export function pageMemorySampler(o: { read: () => number | null; later: (fn: () => void) => void }): PageMemorySampler {
    let last: number | null = null;
    const sample = (): void => { last = o.read(); };
    return { sample, loaded: sample, bytes: () => last, mb: () => (last === null ? null : Math.round(last / (1024 * 1024))) };
}
