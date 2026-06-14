import { BrowserWindow, ipcMain } from 'electron';
import { getHostClient, type TerminalInfo } from '@particle-academy/fancy-term-host';

/**
 * Manual-quit terminal confirmation (the counterpart to the update-quit flow).
 *
 * THE PROBLEM. With Tier 3 detached terminals (`detached_terminals` ON →
 * host-backed), a NORMAL quit deliberately LEAVES the ptys running — the host
 * outlives Genie so the next launch reattaches live sessions
 * (`disconnectHostLeaveRunning`). That's the whole point of T3. But it means
 * quitting Genie silently leaves shells (dev servers, agents, …) running in the
 * background, which can surprise a user who thinks "quit" means "stop".
 *
 * THE FEATURE. On a MANUAL quit, when host-backed AND there is ≥1 live host
 * terminal AND a master window is open, we intercept the quit and ask the user
 * which terminals to KEEP RUNNING vs SHUT DOWN. Default: keep all running
 * (matches today's behaviour). On confirm we kill the deselected ones via the
 * host client, leave the rest, then quit. On cancel we abort the quit.
 *
 * THE UPDATE PATH IS UNTOUCHED. The auto-update teardown snapshots + shuts the
 * WHOLE host down for the binary swap (`isQuittingForUpdate()` gates that). This
 * dialog is ONLY for manual quits — `background.ts` checks `isQuittingForUpdate()`
 * before invoking anything here.
 *
 * This module is the runtime-agnostic-ish DECISION LAYER: it answers
 *   - "should we even show the dialog?"  (shouldConfirmQuit)
 *   - "what live host terminals exist?"  (liveHostTerminals)
 *   - "apply the user's keep/kill choice" (applyQuitDecision)
 * so `background.ts` stays a thin before-quit state machine and the logic is
 * unit-testable (mock the host client + BrowserWindow).
 */

/** Channel main → renderer: open the confirm dialog with the live terminals. */
export const CONFIRM_QUIT_CHANNEL = 'app:confirm-quit-terminals';
/** Channel renderer → main: the user's decision. */
export const QUIT_DECISION_CHANNEL = 'app:quit-decision';

/** How long we wait for the renderer's decision before proceeding with the safe
 *  default (leave everything running) so a wedged renderer can't hang quit.
 *  Generous because this is a user-interactive prompt. */
export const QUIT_DECISION_TIMEOUT_MS = 30_000;

/** One live host terminal, as broadcast to the renderer. The renderer joins
 *  these ids to its `specs` (label + workspace + shell); pid/shell are sent so a
 *  terminal with no matching spec still renders something meaningful. */
export interface LiveHostTerminal {
    id: string;
    pid: number;
    shell: string;
}

/** The renderer's reply. `keepIds` are the terminals to LEAVE RUNNING; every
 *  other live id is killed. `confirmed:false` aborts the quit entirely. */
export interface QuitDecision {
    confirmed: boolean;
    keepIds: string[];
}

/**
 * The live host terminals (host-backed only). Empty array when not host-backed
 * or the host client throws. This is what we'd ask the user about.
 */
export function liveHostTerminals(): LiveHostTerminal[] {
    const client = getHostClient();
    if (!client) return [];
    let list: TerminalInfo[] = [];
    try {
        list = client.list();
    } catch {
        return [];
    }
    return list.map((t) => ({ id: t.id, pid: t.pid, shell: t.shell }));
}

/**
 * Whether the manual-quit confirmation should be shown. True ONLY when:
 *   - host-backed (in-process quits kill nothing that survives → no point), AND
 *   - there is ≥1 live host terminal that would keep running, AND
 *   - a master/stage window is open to host the dialog.
 *
 * The caller (background.ts) additionally gates on `!isQuittingForUpdate()` so
 * the update path never reaches here. `hostBacked` is injected (rather than
 * imported) so this stays trivially unit-testable without mocking the whole
 * host module.
 */
export function shouldConfirmQuit(opts: {
    hostBacked: boolean;
    liveTerminals: LiveHostTerminal[];
    hasOpenWindow: boolean;
}): boolean {
    return (
        opts.hostBacked &&
        opts.liveTerminals.length > 0 &&
        opts.hasOpenWindow
    );
}

/**
 * Apply the user's keep/kill decision to the live host terminals: every live id
 * NOT in `keepIds` is killed via the host client. Returns the ids actually asked
 * to die (for logging/tests). Best-effort — a failed kill is swallowed so the
 * quit can always proceed; the host's leave-running teardown handles the kept
 * ones afterwards.
 *
 * Only the ids that were live at decision time are considered (passed in), so a
 * terminal that appeared between broadcast and decision is left alone (it wasn't
 * something the user was shown / chose about).
 */
export function applyQuitDecision(
    liveTerminals: LiveHostTerminal[],
    keepIds: string[],
): string[] {
    const keep = new Set(keepIds);
    const client = getHostClient();
    const killed: string[] = [];
    if (!client) return killed;
    for (const t of liveTerminals) {
        if (keep.has(t.id)) continue;
        try {
            client.kill(t.id);
            killed.push(t.id);
        } catch {
            /* best-effort — host may have already dropped it */
        }
    }
    return killed;
}

/**
 * Pick the master window to host the dialog. Prefer a window currently focused;
 * otherwise the first non-destroyed window. Returns null when no window is open
 * (the no-window fallback path: quit without a dialog).
 */
export function pickDialogWindow(): BrowserWindow | null {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) return focused;
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) return w;
    }
    return null;
}

/** The terminal outcome of the confirm flow, handed back to background.ts. */
export type QuitConfirmOutcome =
    | 'proceed' // confirmed/timeout/no-window/send-failed → run the teardown tail
    | 'cancelled'; // user cancelled → abort the quit, stay open

/**
 * Run the manual-quit confirmation against the chosen window and resolve with
 * the OUTCOME for background.ts to act on:
 *   - 'cancelled' → the user cancelled; abort the quit (don't tear down).
 *   - 'proceed'   → confirm / timeout / no-window / send-failure; the caller then
 *                   runs the normal teardown tail (which leaves the kept ones
 *                   running). On confirm, the deselected terminals are ALREADY
 *                   killed here before we resolve.
 *
 * Bounded by `timeoutMs` (the renderer is interactive, so generous) — a wedged
 * renderer resolves 'proceed' with the SAFE default (leave all running) rather
 * than hanging quit forever. Self-contained: registers + tears down its own
 * one-shot ipcMain listener and timer; never resolves twice.
 *
 * Injected `window`/`broadcast` keep this unit-testable without a real
 * BrowserWindow — the caller passes the picked window and a sender shim.
 */
export function confirmQuitTerminals(opts: {
    liveTerminals: LiveHostTerminal[];
    /** The window to show the dialog in (from pickDialogWindow). */
    send: (channel: string, payload: unknown) => void;
    /** Bring the dialog window forward; best-effort, may throw if torn down. */
    focusWindow?: () => void;
    timeoutMs?: number;
}): Promise<QuitConfirmOutcome> {
    const { liveTerminals, send } = opts;
    const timeoutMs = opts.timeoutMs ?? QUIT_DECISION_TIMEOUT_MS;

    return new Promise<QuitConfirmOutcome>((resolve) => {
        let settled = false;

        const finish = (
            outcome: QuitConfirmOutcome,
            keepIds?: string[],
        ): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ipcMain.removeListener(QUIT_DECISION_CHANNEL, onDecision);
            if (outcome === 'proceed' && keepIds) {
                // Kill the deselected host terminals; the kept ones are left for
                // the caller's normal teardown to keep running.
                applyQuitDecision(liveTerminals, keepIds);
            }
            resolve(outcome);
        };

        const onDecision = (_e: unknown, decision: QuitDecision): void => {
            if (decision && decision.confirmed === false) {
                finish('cancelled');
                return;
            }
            const keepIds = Array.isArray(decision?.keepIds)
                ? decision.keepIds
                : liveTerminals.map((t) => t.id);
            finish('proceed', keepIds);
        };

        // Timeout → SAFE default: leave EVERYTHING running, then proceed to quit.
        const timer = setTimeout(() => {
            finish('proceed', liveTerminals.map((t) => t.id));
        }, timeoutMs);

        ipcMain.on(QUIT_DECISION_CHANNEL, onDecision);
        try {
            send(CONFIRM_QUIT_CHANNEL, { terminals: liveTerminals });
            opts.focusWindow?.();
        } catch {
            // Window tore down between pick and send → leave all running + quit.
            finish('proceed', liveTerminals.map((t) => t.id));
        }
    });
}
