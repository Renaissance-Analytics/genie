/**
 * A RENDER ERROR, AS GENIE LOGS AND COPIES IT (parity audit 2026-10-30, top-15 #7).
 *
 * The renderer's error boundaries (renderer/components/ErrorBoundary.tsx) keep a throw inside the surface that threw. What
 * they report goes two places:
 *
 * - **Genie's log.** The renderer's console reaches no file, in the installed app or anywhere else. Genie 1's boundary
 *   logged only there (`renderer/components/ErrorBoundary.tsx` componentDidCatch, v0.7.0-beta.342), so a crash a person
 *   saw left nothing behind. Here the boundary prints ONE line with `RENDER_ERROR_PREFIX`, and main — which already
 *   forwards the composer-focus line the same way (genie#1235) — writes it to main's error output and to
 *   `~/.genie/runtime/lifecycle.log`, the one log Genie keeps on disk (main/lifecycle-log.ts).
 * - **The person's clipboard**, from the card's Copy details: the surface, the message, the stack and React's component
 *   stack, for an issue.
 */

export const RENDER_ERROR_PREFIX = '[genie] render error:';
const FOCUS_PREFIX = '[genie] focus:';

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === 'string') return error;
    try {
        return String(error);
    } catch {
        return 'an unprintable value';
    }
}

const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ').trim();

/** The first frame of a stack (`Dashboard (app.js:1:2)`), or null. */
function topFrame(error: unknown): string | null {
    if (!(error instanceof Error) || !error.stack) return null;
    const frame = error.stack.split('\n').map((l) => l.trim()).find((l) => l.startsWith('at '));
    return frame ? frame.slice(3) : null;
}

/** The line a boundary prints: the prefix, the surface, the message and where it threw, on ONE line whatever the message holds. */
export function renderErrorLine(surface: string, error: unknown): string {
    const where = topFrame(error);
    return `${RENDER_ERROR_PREFIX} surface=${oneLine(surface)} message=${oneLine(messageOf(error))}${where ? ` at=${oneLine(where)}` : ''}`;
}

/** What Copy details puts on the clipboard. */
export function renderErrorDetails(input: { surface: string; error: unknown; componentStack: string | null; version?: string | null }): string {
    const stack = input.error instanceof Error && input.error.stack ? input.error.stack : messageOf(input.error);
    return [
        `Genie${input.version ? ` ${input.version}` : ''} — ${input.surface} failed to draw`,
        `Error: ${messageOf(input.error)}`,
        '',
        stack,
        ...(input.componentStack ? ['', 'Component stack:', input.componentStack.replace(/^\n+/, '')] : []),
    ].join('\n');
}

/**
 * MAIN'S FILTER on a renderer window's console (`webContents` 'console-message'), for every window with a renderer of
 * Genie's (main.ts, doctor.ts). Only the lines Genie means to keep are forwarded; everything else a renderer prints stays
 * in its DevTools.
 */
export function forwardRendererConsole(message: string, ports: { out(line: string): void; err(line: string): void; log(line: string): void }): void {
    if (message.startsWith(FOCUS_PREFIX)) {
        ports.out(message);
        return;
    }
    if (message.startsWith(RENDER_ERROR_PREFIX)) {
        const line = oneLine(message);
        ports.err(line);
        ports.log(`render-error ${line.slice(RENDER_ERROR_PREFIX.length).trim()}`);
    }
}
