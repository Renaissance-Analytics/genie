/**
 * UPGRADE A REMOTE HOST FROM HERE (Tynn #822; Genie 1's remote.upgradeHost, owner only).
 *
 * The remote protocol already carries the host's own updater (updates.check / download / install — refused to a
 * shared-workspace guest, main/remote-host.ts). This is the client's flow over it, Genie 1's:
 *
 *   checking → up to date (ends) | the update: downloading → installing → the host restarts and the link DROPS — which is
 *   EXPECTED, so → reconnecting, every `retryMs`, until the host answers (done) or `giveUpMs` passes (lost, said).
 *
 * Every failure ends the flow in words, and nothing runs after it. Pure: the updater, the reconnect, the clock and the
 * sleep are passed in.
 */
export type HostUpgradeStep =
    | { kind: 'checking' }
    | { kind: 'up-to-date' }
    | { kind: 'downloading'; version: string }
    | { kind: 'installing'; version: string }
    | { kind: 'reconnecting'; version: string }
    | { kind: 'done'; version: string }
    | { kind: 'lost'; version: string }
    | { kind: 'failed'; reason: string };

export interface HostUpgradePorts {
    readonly updates: {
        check(): Promise<{ phase: string; version: string | null; error: string | null }>;
        download(): Promise<boolean>;
        install(): Promise<{ report: string } | null> | { report: string } | null;
    };
    /** One reconnect attempt; `true` once the host answers again. */
    reconnect(): Promise<boolean>;
    sleep(ms: number): Promise<void>;
    now(): number;
    onStep(step: HostUpgradeStep): void;
    readonly retryMs?: number;
    readonly giveUpMs?: number;
}

export async function upgradeHost(ports: HostUpgradePorts): Promise<HostUpgradeStep> {
    const retryMs = ports.retryMs ?? 3_000;
    const giveUpMs = ports.giveUpMs ?? 300_000;
    const say = (step: HostUpgradeStep): HostUpgradeStep => { ports.onStep(step); return step; };

    say({ kind: 'checking' });
    let checked: { phase: string; version: string | null; error: string | null };
    try {
        checked = await ports.updates.check();
    } catch (error) {
        return say({ kind: 'failed', reason: `the host could not be asked to check: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (checked.phase === 'none') return say({ kind: 'up-to-date' });
    if (checked.phase === 'error') return say({ kind: 'failed', reason: `the host’s updater says: ${checked.error ?? 'an error'}` });
    if ((checked.phase !== 'available' && checked.phase !== 'downloaded') || !checked.version) {
        return say({ kind: 'failed', reason: `the host’s updater is ${checked.phase} — try again shortly` });
    }
    const version = checked.version;
    if (checked.phase === 'available') {
        say({ kind: 'downloading', version });
        if (!(await ports.updates.download().catch(() => false))) return say({ kind: 'failed', reason: `the host could not download ${version}` });
    }
    say({ kind: 'installing', version });
    const installed = await Promise.resolve(ports.updates.install()).catch(() => null);
    if (installed === null) return say({ kind: 'failed', reason: `the host refused to install ${version}` });

    // The host restarts: the link drops, and that is the plan — reconnect until it answers, or say it is lost.
    say({ kind: 'reconnecting', version });
    const started = ports.now();
    while (ports.now() - started < giveUpMs) {
        await ports.sleep(retryMs);
        if (await ports.reconnect().catch(() => false)) return say({ kind: 'done', version });
    }
    return say({ kind: 'lost', version });
}
