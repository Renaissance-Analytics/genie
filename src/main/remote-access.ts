/**
 * THIS MACHINE AS A HOST FOLLOWS ITS SWITCH (Tynn #820; the owner, 2026-10-19: remote access "Off by default", as Genie 1
 * had it — mobile.setRemoteEnabled, restart). Genie 2 started the listener whenever Tailscale was present, so another
 * device on the tailnet could reach this Genie without anyone having turned it on. Now the listener runs only while
 * `remote_access` is on: applied at boot and on every change of the setting; Restart stops and starts it while on.
 */
export interface RemoteAccessListener {
    start(): Promise<void>;
    stop(): Promise<void>;
    /** `null` while it listens; otherwise why not (`not started`, `stopped`, no Tailscale…). */
    unavailable(): string | null;
}

export function remoteAccess(input: { listener: RemoteAccessListener; enabled: () => boolean; onChange: () => void }) {
    const { listener, enabled, onChange } = input;
    const apply = async (): Promise<void> => {
        if (enabled()) {
            if (listener.unavailable() !== null) await listener.start();
        } else if (listener.unavailable() === null) {
            await listener.stop();
        }
        onChange();
    };
    const restart = async (): Promise<void> => {
        if (!enabled()) { await apply(); return; }
        await listener.stop();
        await listener.start();
        onChange();
    };
    /*
     * ONE AT A TIME (Azure pair gp-11102138, beta.61): the window's apply and genie-host's own setting watcher came together
     * while a start was still asking Tailscale for its cert, both saw no listener yet, and the second bound the same port
     * (`listen EADDRINUSE`). Each waits for the one before; the second then sees the listener up and starts nothing.
     */
    let queue: Promise<void> = Promise.resolve();
    const inTurn = (step: () => Promise<void>): Promise<void> => {
        const run = queue.then(step);
        queue = run.catch(() => {});
        return run;
    };
    return {
        apply: () => inTurn(apply),
        restart: () => inTurn(restart),
    };
}
