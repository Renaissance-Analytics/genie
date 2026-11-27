import { Button, Icon, Tooltip } from '@particle-academy/react-fancy';
import type { HostDirectoryView, HostRow } from '../../core/host-directory.js';
import type { HostDirectoryAction } from '../../main/host-directory-window.js';
import { GenieLogo } from './GenieLogo.js';

/**
 * THE HOST DIRECTORY (Tynn #1058 L4): the hosts a client with no host to link to can pick, in Genie's own window and design
 * system (the coordinator's review, 2026-11-27). Genie's title bar; each host a row with its icon, a status dot and its
 * name in bold; one short line under it, the rest behind an info icon; Add a host and Start the primary actions, Start
 * saying Starting… and then its result on the row. Hook-free, so a test can render it.
 */
const DOT: Record<HostRow['dot'], string> = {
    green: 'bg-[var(--success)]',
    amber: 'bg-[var(--amber-500)]',
    red: 'bg-[var(--danger)]',
    grey: 'bg-[var(--fg-4)]',
};
const DOT_WORDS: Record<HostRow['state'], string> = { running: 'Running', stopped: 'Stopped', failed: 'Could not start', incompatible: 'Needs an update', paired: 'Paired, not reachable from here yet' };

function HostRowView({ h, busy, onAction }: { h: HostRow; busy: string | null; onAction: (action: HostDirectoryAction) => void }) {
    const starting = busy === h.id && h.action?.kind === 'start';
    return (
        <li data-host-row={h.id} data-host-state={h.state} className="flex items-center gap-3 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-3">
            <span data-host-icon={h.icon} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-2)] text-[var(--fg-2)]">
                <Icon name={h.icon} size="sm" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                    <Tooltip content={DOT_WORDS[h.state]} placement="top">
                        <span data-status-dot={h.dot} aria-label={DOT_WORDS[h.state]} className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[h.dot]}`} />
                    </Tooltip>
                    <span data-host-name={h.id} className="truncate text-[14px] font-semibold">{h.name}</span>
                    {h.address ? <span className="truncate font-mono text-[11px] text-[var(--fg-4)]">{h.address}</span> : null}
                </div>
                <div className="flex items-center gap-1.5 text-[12px] text-[var(--fg-3)]">
                    <span className="truncate">{starting ? 'Starting Genie’s host…' : h.detail}</span>
                    {h.more ? (
                        <Tooltip content={h.more} placement="top" className="max-w-sm">
                            <span data-host-more={h.id} aria-label={h.more} className="inline-flex shrink-0 text-[var(--fg-4)]"><Icon name="info" size="xs" /></span>
                        </Tooltip>
                    ) : null}
                </div>
            </div>
            {h.action ? (
                h.action.kind === 'start' ? (
                    <Button size="sm" type="button" color="blue" data-action="start" data-primary="" loading={starting} disabled={busy !== null} onClick={() => onAction('start')}>
                        {starting ? 'Starting…' : h.action.label}
                    </Button>
                ) : (
                    <Button size="sm" type="button" data-action={h.action.kind} disabled={busy !== null} onClick={() => onAction(h.action!.kind)}>{h.action.label}</Button>
                )
            ) : null}
        </li>
    );
}

export function HostDirectoryScreen({ view, busy, notice = null, onAction }: { view: HostDirectoryView; busy: string | null; notice?: { ok: boolean; text: string } | null; onAction: (action: HostDirectoryAction) => void }) {
    return (
        <div data-host-directory="" className="flex h-screen flex-col bg-[var(--bg-0)] text-[13px] text-[var(--fg-1)]">
            {/* Genie's title bar: the window's drag region (the OS title bar is hidden; the native buttons sit at the right). */}
            <header data-host-directory-titlebar="" className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-3 [-webkit-app-region:drag]">
                <GenieLogo />
                <span className="text-[13px] font-semibold">Genie</span>
                <span className="text-[12px] text-[var(--fg-4)]">· {view.title}</span>
            </header>
            <main className="flex flex-1 items-start justify-center overflow-y-auto px-6 py-14">
                <section className="flex w-full max-w-[640px] flex-col gap-4">
                    <header className="flex items-end justify-between gap-4">
                        <div className="flex flex-col gap-1">
                            <h1 className="text-[20px] font-semibold tracking-tight">{view.title}</h1>
                            <p className="text-[var(--fg-3)]">Pick the host to open a window on.</p>
                        </div>
                        <Button size="sm" type="button" color="blue" data-action="add-host" data-primary="" disabled={busy !== null} onClick={() => onAction('add-host')}>
                            <Icon name="plus" size="xs" /> {view.add.label}
                        </Button>
                    </header>
                    {view.empty !== null ? (
                        <div data-host-directory-empty="" className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-2)] bg-[var(--bg-1)] px-6 py-12 text-center">
                            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--bg-2)] text-[var(--fg-3)]"><Icon name="monitor" size="md" /></span>
                            <p role="status" className="text-[14px] font-medium">{view.empty}</p>
                        </div>
                    ) : (
                        <ul data-host-rows="" className="flex flex-col gap-2">
                            {view.hosts.map((h) => <HostRowView key={h.id} h={h} busy={busy} onAction={onAction} />)}
                        </ul>
                    )}
                    {notice ? (
                        notice.ok
                            ? <p data-host-directory-notice="ok" role="status" className="flex items-center gap-1.5 text-[12px] text-[var(--fg-2)]"><Icon name="check" size="xs" /> {notice.text}</p>
                            : <p data-host-directory-notice="failed" role="alert" className="flex items-center gap-1.5 text-[12px] text-[var(--danger)]"><Icon name="circle-alert" size="xs" /> {notice.text}</p>
                    ) : null}
                </section>
            </main>
        </div>
    );
}
