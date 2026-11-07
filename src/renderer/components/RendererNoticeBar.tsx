import { useState } from 'react';
import { Button } from '@particle-academy/react-fancy';
import { clockAmPm, fullDateTime } from '../../core/clock-words.js';
import { rendererNoticeWords, type RendererNotice } from '../../core/renderer-notice.js';
import { CrashReport, type CrashReportPort, type SafeModeAnswer } from './SafeModeBanner.js';

export interface RendererNoticeBarProps {
    notice: RendererNotice | null | undefined;
    /** How the time reads (`3:04 PM`); the viewer's own clock by default, as the hang notice's. */
    clock?: (at: number) => string;
    /** The window forgets the notice. */
    onDismiss: () => Promise<SafeModeAnswer>;
    /** "Send a crash report" (never automatic). */
    crashReport?: CrashReportPort | undefined;
}

type Step = { phase: 'busy' } | { phase: 'failed'; reason: string };

/**
 * THE BROUGHT-BACK PAGE'S NOTICE (Tynn #386; main/renderer-recovery.ts). This window's page ended — out of memory, a crash,
 * the system ending it — and main reloaded it; the host and every agent kept running. "Send a crash report" as on the hang
 * notice. Dismiss shows progress, then goes, or says why with Retry.
 */
export function RendererNoticeBar({ notice, clock = clockAmPm, onDismiss, crashReport }: RendererNoticeBarProps) {
    const [dismiss, setDismiss] = useState<Step | null>(null);
    if (!notice) return null;
    const run = () => {
        setDismiss({ phase: 'busy' });
        void onDismiss().then(
            (answer) => setDismiss(answer.ok ? null : { phase: 'failed', reason: answer.reason }),
            (error: unknown) => setDismiss({ phase: 'failed', reason: error instanceof Error ? error.message : String(error) }),
        );
    };
    return (
        <div role="status" data-renderer-notice={notice.reason} className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-2 text-[12px] text-[var(--fg-2)]">
            <div className="flex items-center gap-3">
                <span className="text-[var(--warning)]" title={fullDateTime(notice.at)}>{rendererNoticeWords(notice, clock)}</span>
                <Button type="button" size="xs" variant="ghost" data-action="renderer-notice-dismiss" disabled={dismiss?.phase === 'busy'} onClick={run}>
                    {dismiss?.phase === 'busy' ? 'Dismissing…' : dismiss?.phase === 'failed' ? 'Retry' : 'Dismiss'}
                </Button>
                {dismiss?.phase === 'failed' ? <span data-renderer-outcome="dismiss" className="text-[var(--danger,#d33)]">Not dismissed: {dismiss.reason}</span> : null}
            </div>
            {crashReport ? <CrashReport port={crashReport} /> : null}
        </div>
    );
}
