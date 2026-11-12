import { Button } from '@particle-academy/react-fancy';
import type { HostWaitAction, HostWaitView } from '../../main/host-wait-window.js';

/**
 * THE WAIT FOR GENIE'S HOST (Tynn #700): what is happening and for how long, and from 60 s "Open the log" and "Restart
 * Genie's host", each showing progress while it runs and its outcome after. Hook-free, so a test can render it.
 */
export function HostWaitScreen({ view, onAction }: { view: HostWaitView; onAction: (action: HostWaitAction) => void }) {
    const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-[12px] text-[var(--fg-1)] hover:bg-[var(--bg-2)] disabled:opacity-60';
    return (
        <main data-host-wait="" className="flex h-screen flex-col justify-center gap-2 bg-[var(--bg-0)] px-6 text-[13px] text-[var(--fg-1)]">
            <p role="status" className="font-semibold">{view.title}</p>
            <p data-host-wait-detail="" className="text-[var(--fg-3)]">{view.detail}</p>
            {view.actions ? (
                <div className="mt-1 flex gap-2">
                    <Button size="xs" type="button" data-action="open-log" loading={view.busy === 'open-log'} disabled={view.busy !== null} className={button} onClick={() => onAction('open-log')}>Open the log</Button>
                    <Button size="xs" type="button" data-action="restart-host" loading={view.busy === 'restart'} disabled={view.busy !== null} className={button} onClick={() => onAction('restart')}>Restart Genie’s host</Button>
                </div>
            ) : null}
            {view.outcome ? (
                view.outcome.ok
                    ? <p data-host-wait-outcome="ok" role="status" className="text-[12px] text-[var(--fg-2)]">{view.outcome.text}</p>
                    : <p data-host-wait-outcome="failed" role="alert" className="text-[12px] text-[var(--danger)]">{view.outcome.text}</p>
            ) : null}
        </main>
    );
}
