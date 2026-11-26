import { Button } from '@particle-academy/react-fancy';
import type { HostDirectoryView, HostRow } from '../../core/host-directory.js';
import type { HostDirectoryAction } from '../../main/host-directory-window.js';

/**
 * THE HOST DIRECTORY (Tynn #1058 L4): the hosts a client with no host to link to can pick, in Genie's own design system.
 * The local host is one row among them (stopped: Start through the launcher; could not start: Open log); paired hosts by
 * name and address; the empty state in the spec's words, and Add a host. Hook-free, so a test can render it.
 */
const STATE_WORDS: Record<HostRow['state'], string> = { stopped: 'Stopped', failed: 'Could not start', incompatible: 'Needs an update', paired: 'Paired' };
const STATE_TONE: Record<HostRow['state'], string> = {
    stopped: 'border-[var(--amber-500)] text-[var(--amber-500)]',
    failed: 'border-[var(--danger)] text-[var(--danger)]',
    incompatible: 'border-[var(--amber-500)] text-[var(--amber-500)]',
    paired: 'border-[var(--border-2)] text-[var(--fg-3)]',
};

export function HostDirectoryScreen({ view, busy, notice = null, onAction }: { view: HostDirectoryView; busy: string | null; notice?: { ok: boolean; text: string } | null; onAction: (action: HostDirectoryAction) => void }) {
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px] text-[var(--fg-1)] hover:bg-[var(--bg-2)] disabled:opacity-60';
    return (
        <main data-host-directory="" className="flex h-screen items-start justify-center overflow-y-auto bg-[var(--bg-0)] px-6 py-16 text-[13px] text-[var(--fg-1)]">
            <section className="flex w-full max-w-[640px] flex-col gap-4">
                <header className="flex flex-col gap-1">
                    <h1 className="text-[20px] font-semibold tracking-tight">{view.title}</h1>
                    <p className="text-[var(--fg-3)]">Genie opens a window on a host. Pick the one to open.</p>
                </header>
                {view.empty !== null ? (
                    <div data-host-directory-empty="" className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--border-2)] bg-[var(--bg-1)] px-6 py-10 text-center">
                        <p role="status" className="text-[14px] font-medium">{view.empty}</p>
                    </div>
                ) : (
                    <ul data-host-rows="" className="flex flex-col gap-2">
                        {view.hosts.map((h) => (
                            <li key={h.id} data-host-row={h.id} data-host-state={h.state} className="flex flex-col gap-1.5 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-3">
                                <div className="flex items-center gap-2">
                                    <span className="text-[14px] font-medium">{h.name}</span>
                                    {h.address ? <span className="truncate font-mono text-[11px] text-[var(--fg-4)]">{h.address}</span> : null}
                                    <span className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${STATE_TONE[h.state]}`}>{STATE_WORDS[h.state]}</span>
                                    {h.action ? (
                                        <Button size="xs" type="button" data-action={h.action.kind} loading={busy === h.id} disabled={busy !== null} className={button} onClick={() => onAction(h.action!.kind)}>{h.action.label}</Button>
                                    ) : null}
                                </div>
                                <p className="text-[12px] text-[var(--fg-3)]">{h.detail}</p>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="flex items-center gap-3">
                    <Button size="xs" type="button" data-action="add-host" disabled={busy !== null} className={button} onClick={() => onAction('add-host')}>{view.add.label}</Button>
                </div>
                {notice ? (
                    notice.ok
                        ? <p data-host-directory-notice="ok" role="status" className="text-[12px] text-[var(--fg-2)]">{notice.text}</p>
                        : <p data-host-directory-notice="failed" role="alert" className="text-[12px] text-[var(--danger)]">{notice.text}</p>
                ) : null}
            </section>
        </main>
    );
}
