import { useState } from 'react';
import { Button } from '@particle-academy/react-fancy';
import { clockAmPm, fullDateTime } from '../../core/clock-words.js';
import { CRASH_LOOP_WORDS, safeModeWords, type SafeModeView } from '../../core/safe-mode.js';

export type SafeModeAnswer = { ok: true } | { ok: false; reason: string };

/**
 * A crash report's send (Tynn #386 part 4): `signIn` = this Genie is not signed in or enrolled with Tynn, so it cannot
 * send; `cleaned` = Genie's redaction would change the text, which comes back to be looked at again instead of being sent.
 */
export type CrashReportAnswer = { ok: true; issueUrl: string } | { ok: false; reason: string; signIn?: boolean; cleaned?: string };
export interface CrashReportPort {
    /** The report as Genie built it, redacted: exactly what the person is shown. */
    draft(): Promise<{ text: string }>;
    send(text: string, notes: string): Promise<CrashReportAnswer>;
    copy(text: string): Promise<boolean>;
}
export type SafeModeKind = 'agent' | 'process' | 'site';

export interface SafeModeBannerProps {
    view: SafeModeView | null | undefined;
    agentName: (agentId: string) => string;
    /** How the time reads (`11:12 PM`); the viewer's own clock by default. */
    clock?: (at: number) => string;
    /** The normal Start for that one thing: an agent's is the one Restart every Start calls (genie#1238). */
    onStart: (kind: SafeModeKind, id: string) => Promise<SafeModeAnswer>;
    /** "Leave safe mode": starts nothing; automatic behaviour is back on. */
    onLeave: () => Promise<SafeModeAnswer>;
    /** "Send a crash report" (never automatic). Absent = this window cannot send one. */
    crashReport?: CrashReportPort | undefined;
}

type Step = { phase: 'busy' } | { phase: 'done' } | { phase: 'failed'; reason: string };

/**
 * SAFE MODE'S BANNER (spec §2; Tynn #386), on every window while genie-host is in safe mode: when and why the last run
 * ended uncleanly and that nothing was started; what was running, each with its OWN Start (exactly that one); and "Leave
 * safe mode", which starts nothing by itself. Every action shows progress, then Started or the reason with Retry.
 */
export function SafeModeBanner({ view, agentName, clock = clockAmPm, onStart, onLeave, crashReport }: SafeModeBannerProps) {
    const [steps, setSteps] = useState<Readonly<Record<string, Step>>>({});
    if (!view?.active) return null;
    const set = (key: string, step: Step) => setSteps((s) => ({ ...s, [key]: step }));
    const run = (key: string, act: () => Promise<SafeModeAnswer>) => {
        set(key, { phase: 'busy' });
        void act().then(
            (answer) => set(key, answer.ok ? { phase: 'done' } : { phase: 'failed', reason: answer.reason }),
            (error: unknown) => set(key, { phase: 'failed', reason: error instanceof Error ? error.message : String(error) }),
        );
    };
    const rows: Array<{ kind: SafeModeKind; id: string; name: string }> = [
        ...view.agents.map((id) => ({ kind: 'agent' as const, id, name: agentName(id) })),
        ...view.processes.map((p) => ({ kind: 'process' as const, id: p.id, name: p.name })),
        ...view.sites.map((s) => ({ kind: 'site' as const, id: s.id, name: s.name })),
    ];
    const leave = steps.leave;
    return (
        <div role="alert" data-safe-mode={view.crashLoop ? 'crash-loop' : 'on'} className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-2 text-[12px] text-[var(--fg-2)]">
            <div className="flex items-center gap-3">
                <span className="text-[var(--warning)]" title={view.at === null ? undefined : fullDateTime(view.at)}>{safeModeWords(view, clock)}</span>
                <Button type="button" size="xs" data-action="safe-mode-leave" disabled={leave?.phase === 'busy'} onClick={() => run('leave', onLeave)}>
                    {leave?.phase === 'busy' ? 'Leaving…' : 'Leave safe mode'}
                </Button>
                {leave?.phase === 'failed' ? <span data-safe-mode-outcome="leave" className="text-[var(--danger,#d33)]">Not left: {leave.reason}</span> : null}
            </div>
            {view.crashLoop ? <div>{CRASH_LOOP_WORDS}</div> : null}
            {crashReport ? <CrashReport port={crashReport} /> : null}
            {rows.length > 0 ? (
                <ul className="flex flex-wrap gap-x-4 gap-y-1">
                    {rows.map((row) => {
                        const key = `${row.kind}:${row.id}`;
                        const step = steps[key];
                        return (
                            <li key={key} className="flex items-center gap-2">
                                <span>{row.name}</span>
                                {step?.phase === 'done' ? (
                                    <span data-safe-mode-outcome={key} className="text-[var(--fg-3)]">Started</span>
                                ) : (
                                    <>
                                        <Button type="button" size="xs" data-action="safe-mode-start" data-kind={row.kind} data-id={row.id} disabled={step?.phase === 'busy'} onClick={() => run(key, () => onStart(row.kind, row.id))}>
                                            {step?.phase === 'busy' ? 'Starting…' : step?.phase === 'failed' ? 'Retry' : 'Start'}
                                        </Button>
                                        {step?.phase === 'failed' ? <span data-safe-mode-outcome={key} className="text-[var(--danger,#d33)]">Not started: {step.reason}</span> : null}
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </div>
    );
}

type ReportStep =
    | { phase: 'closed' }
    | { phase: 'opening' }
    | { phase: 'editing'; text: string; notes: string; status: { kind: 'idle' } | { kind: 'busy' } | { kind: 'failed'; reason: string } | { kind: 'sign-in' } | { kind: 'sent'; issueUrl: string } | { kind: 'copied' } };

/**
 * SEND A CRASH REPORT (Tynn #386 part 4; spec §4). Never automatic: the person opens it, sees the EXACT text Genie built
 * (already redacted), may edit it and say what they were doing, and nothing leaves until Send. Send shows progress, then
 * the issue's link — or the reason with Retry. A Genie that cannot send (not signed in to Tynn) says so in one line, with
 * a Copy of the report. Cancel discards it.
 */
function CrashReport({ port }: { port: CrashReportPort }) {
    const [step, setStep] = useState<ReportStep>({ phase: 'closed' });
    if (step.phase === 'closed' || step.phase === 'opening') {
        return (
            <div>
                <Button type="button" size="xs" data-action="crash-report-open" loading={step.phase === 'opening'} disabled={step.phase === 'opening'}
                    onClick={() => { setStep({ phase: 'opening' }); void port.draft().then((d) => setStep({ phase: 'editing', text: d.text, notes: '', status: { kind: 'idle' } }), () => setStep({ phase: 'closed' })); }}>
                    Send a crash report
                </Button>
            </div>
        );
    }
    const { text, notes, status } = step;
    const edit = (next: Partial<{ text: string; notes: string }>) => setStep({ ...step, ...next, status: status.kind === 'busy' ? status : { kind: 'idle' } });
    const send = () => {
        setStep({ ...step, status: { kind: 'busy' } });
        void port.send(text, notes).then(
            (a) => {
                if (a.ok) setStep({ phase: 'editing', text, notes, status: { kind: 'sent', issueUrl: a.issueUrl } });
                else if (a.signIn) setStep({ phase: 'editing', text, notes, status: { kind: 'sign-in' } });
                else setStep({ phase: 'editing', text: a.cleaned ?? text, notes, status: { kind: 'failed', reason: a.reason } });
            },
            (e: unknown) => setStep({ phase: 'editing', text, notes, status: { kind: 'failed', reason: e instanceof Error ? e.message : String(e) } }),
        );
    };
    if (status.kind === 'sent') {
        return (
            <div className="flex items-center gap-2">
                <span>Crash report sent.</span>
                <Button type="button" size="xs" variant="ghost" href={status.issueUrl} target="_blank" data-crash-report-issue="">See the issue</Button>
            </div>
        );
    }
    const busy = status.kind === 'busy';
    return (
        <div data-crash-report="" className="flex max-w-[72ch] flex-col gap-1.5">
            <span className="text-[var(--fg-3)]">This is exactly what will be sent. Edit it if you like.</span>
            <textarea data-crash-report-text="" value={text} rows={8} onChange={(e) => edit({ text: e.currentTarget.value })} className="rounded-md border border-[var(--border-1)] bg-transparent p-2 font-mono text-[11px]" />
            <textarea data-crash-report-notes="" value={notes} rows={2} placeholder="What were you doing?" onChange={(e) => edit({ notes: e.currentTarget.value })} className="rounded-md border border-[var(--border-1)] bg-transparent p-2 text-[12px]" />
            <div className="flex items-center gap-2">
                <Button type="button" size="xs" data-action="crash-report-send" loading={busy} disabled={busy} onClick={send}>{busy ? 'Sending…' : status.kind === 'failed' ? 'Retry' : 'Send'}</Button>
                <Button type="button" size="xs" variant="ghost" data-action="crash-report-cancel" disabled={busy} onClick={() => setStep({ phase: 'closed' })}>Cancel</Button>
                {status.kind === 'failed' ? <span data-crash-report-failure="" role="status" className="text-[var(--danger,#d33)]">{status.reason}</span> : null}
            </div>
            {status.kind === 'sign-in' || status.kind === 'copied' ? (
                <div className="flex items-center gap-2">
                    <span data-crash-report-sign-in="">Sign in to Tynn to send this report</span>
                    <Button type="button" size="xs" variant="ghost" data-action="crash-report-copy" onClick={() => { void port.copy(text).then((ok) => { if (ok) setStep({ phase: 'editing', text, notes, status: { kind: 'copied' } }); }); }}>{status.kind === 'copied' ? 'Copied' : 'Copy'}</Button>
                </div>
            ) : null}
        </div>
    );
}
