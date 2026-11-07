import { useState } from 'react';
import { Button } from '@particle-academy/react-fancy';
import { clockAmPm, fullDateTime } from '../../core/clock-words.js';
import { hangNoticeWords, type HangNotice } from '../../core/crash-record.js';
import { CrashReport, type CrashReportPort, type SafeModeAnswer } from './SafeModeBanner.js';

export interface HangNoticeBarProps {
    notice: HangNotice | null | undefined;
    /** How the time reads (`10:00 AM`); the viewer's own clock by default, as the safe-mode banner's. */
    clock?: (at: number) => string;
    /** "Stop all agents": one click, the person's choice — offered after a second hang within 10 minutes, never automatic. */
    onStopAll: () => Promise<SafeModeAnswer>;
    /** The host forgets the notice. */
    onDismiss: () => Promise<SafeModeAnswer>;
    /** "Send a crash report" (never automatic), built from the host's latest record. */
    crashReport?: CrashReportPort | undefined;
}

type Step = { phase: 'busy' } | { phase: 'done' } | { phase: 'failed'; reason: string };

/**
 * THE REOPENED WINDOW'S NOTICE (#1623 review; Tynn story #386). genie-host ended a window that stopped responding and
 * started this one; the host — and every agent — kept running, so this is NOT safe mode: nothing was held back.
 * "Send a crash report" as on the safe-mode banner. After a SECOND hang within 10 minutes, what was running and "Stop all
 * agents": one click, the person's choice. Every action shows progress, then its outcome or the reason with Retry.
 */
export function HangNoticeBar({ notice, clock = clockAmPm, onStopAll, onDismiss, crashReport }: HangNoticeBarProps) {
    const [steps, setSteps] = useState<Readonly<Record<string, Step>>>({});
    if (!notice) return null;
    const set = (key: string, step: Step) => setSteps((s) => ({ ...s, [key]: step }));
    const run = (key: string, act: () => Promise<SafeModeAnswer>) => {
        set(key, { phase: 'busy' });
        void act().then(
            (answer) => set(key, answer.ok ? { phase: 'done' } : { phase: 'failed', reason: answer.reason }),
            (error: unknown) => set(key, { phase: 'failed', reason: error instanceof Error ? error.message : String(error) }),
        );
    };
    const stop = steps['stop-all'];
    const dismiss = steps.dismiss;
    return (
        <div role="status" data-hang-notice={notice.hangs} className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-2 text-[12px] text-[var(--fg-2)]">
            <div className="flex items-center gap-3">
                <span className="text-[var(--warning)]" title={fullDateTime(notice.at)}>{hangNoticeWords(notice, clock)}</span>
                <Button type="button" size="xs" variant="ghost" data-action="hang-notice-dismiss" disabled={dismiss?.phase === 'busy'} onClick={() => run('dismiss', onDismiss)}>
                    {dismiss?.phase === 'busy' ? 'Dismissing…' : dismiss?.phase === 'failed' ? 'Retry' : 'Dismiss'}
                </Button>
                {dismiss?.phase === 'failed' ? <span data-hang-outcome="dismiss" className="text-[var(--danger,#d33)]">Not dismissed: {dismiss.reason}</span> : null}
            </div>
            {crashReport ? <CrashReport port={crashReport} /> : null}
            {notice.hangs >= 2 ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>It has stopped responding {notice.hangs} times in 10 minutes. Running:</span>
                    <ul className="flex flex-wrap gap-x-3">
                        {notice.agents.map((a) => <li key={a.id} data-hang-agent={a.id}>{a.name}</li>)}
                    </ul>
                    {stop?.phase === 'done' ? (
                        <span data-hang-outcome="stop-all" className="text-[var(--fg-3)]">Stopped</span>
                    ) : (
                        <>
                            <Button type="button" size="xs" data-action="hang-stop-all" disabled={stop?.phase === 'busy'} onClick={() => run('stop-all', onStopAll)}>
                                {stop?.phase === 'busy' ? 'Stopping…' : stop?.phase === 'failed' ? 'Retry' : 'Stop all agents'}
                            </Button>
                            {stop?.phase === 'failed' ? <span data-hang-outcome="stop-all" className="text-[var(--danger,#d33)]">Not stopped: {stop.reason}</span> : null}
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
}
