import { useEffect, useRef, useState } from 'react';
import { timeLeftWords, type PairRequest } from '../../core/pair-confirm.js';
import { useNow } from '../use-now.js';

/**
 * "PAIR THIS DEVICE?" — ON THIS MACHINE'S OWN SCREEN (the owner, 2026-10-31, q_8c07b142: "add the confirm").
 *
 * A phone typed the right PIN; nothing is paired until the person presses Allow here. Genie 1 asked the same question
 * (v0.7.0-beta.342 main/background.ts:2841: who, from where, "Approve only if this is YOUR device", Pair / Deny). Here:
 * - a card over the window, on every page — NOT a modal and never focused: it must not take the keyboard out of a
 *   sentence the person is typing (the question window's rule, main/question-window-electron.ts). It has no autoFocus and
 *   calls no focus(); main flashes the taskbar for a window not in front, which does not take focus either;
 * - a real Allow and a real Deny, each a button, both disabled with "Allowing…"/"Denying…" while the answer travels;
 * - what happened, in words, after: paired, denied, nobody answered in time, or the device left — never silent;
 * - an answer that did not land says why and offers Retry.
 */

type Outcome = { kind: 'allowed' | 'denied' | 'expired' | 'gone'; label: string; host: string };

const OUTCOME_MS = 8000;

function outcomeWords(o: Outcome): string {
    switch (o.kind) {
        case 'allowed': return `${o.label} is paired with ${o.host}.`;
        case 'denied': return `Denied: ${o.label} was not paired.`;
        case 'expired': return `Nobody answered in time: ${o.label} was not paired.`;
        case 'gone': return `${o.label} went away before it was allowed; nothing was paired.`;
    }
}

/** Electron wraps a handler's throw as "Error invoking remote method '<channel>': Error: <reason>". */
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');

export interface PairPromptProps {
    readonly requests: readonly PairRequest[];
    /** Allow (`true`) or Deny (`false`) one request; resolves once main has it, rejects with why it did not. */
    readonly onAnswer: (id: string, allow: boolean) => Promise<unknown>;
    /** The clock, for tests; absent = the real one, ticking while a request is up. */
    readonly now?: number | undefined;
}

export function PairPrompt({ requests, onAnswer, now: fixedNow }: PairPromptProps) {
    const request = requests[0] ?? null;
    const now = useNow(request !== null, fixedNow);
    const [busy, setBusy] = useState<{ id: string; allow: boolean } | null>(null);
    const [failed, setFailed] = useState<{ id: string; allow: boolean; reason: string } | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    // What was on screen, and what the person answered: so a request that leaves the snapshot is explained, not dropped.
    const shown = useRef(new Map<string, PairRequest>());
    const answered = useRef(new Map<string, boolean>());

    useEffect(() => {
        const live = new Set(requests.map((r) => r.id));
        for (const r of requests) shown.current.set(r.id, r);
        for (const [id, r] of shown.current) {
            if (live.has(id)) continue;
            shown.current.delete(id);
            const allow = answered.current.get(id);
            answered.current.delete(id);
            // The clock read NOW (the countdown's may be up to a tick behind main's timer): within a second and a half of the
            // deadline, the request lapsed rather than its device leaving.
            const clock = fixedNow ?? Date.now();
            const kind: Outcome['kind'] = allow === true ? 'allowed' : allow === false ? 'denied' : clock >= r.expiresAt - 1500 ? 'expired' : 'gone';
            setOutcome({ kind, label: r.label, host: r.host });
            setBusy((b) => (b?.id === id ? null : b));
            setFailed((f) => (f?.id === id ? null : f));
        }
    }, [requests, fixedNow]);

    useEffect(() => {
        if (!outcome || request) return;
        const t = setTimeout(() => setOutcome(null), OUTCOME_MS);
        return () => clearTimeout(t);
    }, [outcome, request]);

    const answer = (id: string, allow: boolean): void => {
        setBusy({ id, allow });
        setFailed(null);
        // Sent NOW (not on a later tick), so the press and the request are one step.
        let sent: Promise<unknown>;
        try { sent = Promise.resolve(onAnswer(id, allow)); } catch (error) { sent = Promise.reject(error); }
        sent
            .then(() => { answered.current.set(id, allow); })
            .catch((error: unknown) => { setBusy(null); setFailed({ id, allow, reason: reasonOf(error) }); });
    };

    const card = 'pointer-events-auto w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border bg-[var(--bg-1)] p-4 text-sm text-[var(--fg-1)] shadow-xl';
    const btn = 'rounded-lg px-3 py-1.5 text-[13px] font-medium disabled:opacity-60';

    if (!request) {
        if (!outcome) return null;
        return (
            <div className="pointer-events-none fixed bottom-4 right-4 z-50">
                <div data-pair-result="" role="status" className={`${card} flex items-center gap-3 border-[var(--border-1)]`}>
                    <span data-pair-outcome={outcome.kind} className="flex-1">{outcomeWords(outcome)}</span>
                    <button type="button" data-action="dismiss-pair-outcome" onClick={() => setOutcome(null)} className={`${btn} border border-[var(--border-1)]`}>Dismiss</button>
                </div>
            </div>
        );
    }

    const mine = busy?.id === request.id ? busy : null;
    const failure = failed?.id === request.id ? failed : null;
    const more = requests.length - 1;
    return (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50">
            <div data-pair-prompt={request.id} role="alertdialog" aria-modal="false" aria-labelledby={`pair-title-${request.id}`} className={`${card} flex flex-col gap-2 border-[var(--warning)]`}>
                <div className="flex items-baseline gap-2">
                    <h2 id={`pair-title-${request.id}`} className="text-[15px] font-semibold">Pair this device?</h2>
                    <span data-pair-countdown="" className="ml-auto font-mono text-xs text-[var(--fg-3)]">{timeLeftWords(request.expiresAt - now)}</span>
                </div>
                <p>
                    <span className="font-semibold">{request.label}</span>
                    {` wants to pair with ${request.host}, from `}
                    <span className="font-mono text-xs">{request.from}</span>
                    {'. It typed the PIN shown here.'}
                </p>
                {request.replaces ? <p className="text-[var(--fg-2)]">{`It replaces ${request.replaces.label}, whose pairing ends when you allow this one.`}</p> : null}
                <p className="text-xs text-[var(--fg-3)]">{`Once paired it can chat with agents and read and upload files on ${request.host}. Allow only if this is your device.`}</p>
                {failure ? (
                    <p data-pair-failed="" role="alert" className="flex items-center gap-2 text-xs text-[var(--danger)]">
                        <span className="flex-1">{`Your answer did not reach Genie: ${failure.reason}`}</span>
                        <button type="button" data-action="retry-pair-answer" onClick={() => answer(request.id, failure.allow)} className={`${btn} border border-[var(--danger)]`}>Retry</button>
                    </p>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                    {more > 0 ? <span className="mr-auto text-xs text-[var(--fg-3)]">{`${more} more waiting`}</span> : null}
                    <button type="button" data-action="deny-pair" disabled={mine !== null} onClick={() => answer(request.id, false)} className={`${btn} border border-[var(--border-1)] hover:bg-[var(--bg-2)]`}>
                        {mine && !mine.allow ? 'Denying…' : 'Deny'}
                    </button>
                    <button type="button" data-action="allow-pair" disabled={mine !== null} onClick={() => answer(request.id, true)} className={`${btn} bg-[var(--primary)] text-white`}>
                        {mine?.allow ? 'Allowing…' : 'Allow'}
                    </button>
                </div>
            </div>
        </div>
    );
}
