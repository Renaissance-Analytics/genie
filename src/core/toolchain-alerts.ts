import type { Alert } from './alert-diff.js';
import type { ToolStatus } from './toolchain.js';

/**
 * THE DRIFT WATCHER'S ALARM (the owner, 2026-10-22: "make sure we having something in our drift watcher that catches
 * these security issues right away"). The toolchain probe (main/toolchain-prober.ts) runs at boot and every six hours
 * and reads each tool against its security floor (core/toolchain.ts `toolStatus`). What it finds used to reach a person
 * only when they opened Settings → Toolchain. Now the moment a probe reports a tool under its floor the window raises
 * ONE alert for it — the same `ghsecurity` path a GitHub security alert takes, so the sound and the notification are
 * the ones the person already chose for "a security alert" — and not again while it stays that way: an alarm that
 * rings every six hours for the same hole trains people to silence it. A tool fixed and later found unsafe again rings
 * again.
 */
export function toolchainSecurityAlerts(prev: readonly ToolStatus[] | null, next: readonly ToolStatus[]): Alert[] {
    const already = new Set((prev ?? []).filter((t) => t.tone === 'security-update').map((t) => t.tool));
    return next
        .filter((t) => t.tone === 'security-update' && !already.has(t.tool))
        .map((t) => ({ kind: 'ghsecurity', workspace: '—', agent: 'Toolchain', detail: t.advisory ?? `${t.tool} ${t.installed ?? ''} needs a security update` }));
}
