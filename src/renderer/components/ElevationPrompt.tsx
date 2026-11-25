import { Button } from '@particle-academy/react-fancy';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ElevationBridge, ElevationPromptEvent } from '../../core/elevation.js';

/**
 * GENIE'S OWN PASSWORD PROMPT (Tynn #973; the owner's decision of 2026-11-20). An elevated step on Linux (installing or
 * updating a system package) asks the client the person clicked from for their password, naming the exact packages and
 * the commands that will run. The host runs them once with it and drops it.
 *
 * THE PASSWORD IS NEVER KEPT HERE: the field is uncontrolled (no React state holds what is typed), it is read once on
 * Allow, emptied at once, and handed to the bridge's answer, which sends it to the host and nowhere else. Cancel says
 * so; a wrong password comes back as a NEW prompt (a new id, an empty field) saying it was not accepted.
 */

type Ask = Extract<ElevationPromptEvent, { kind: 'ask' }>;

export interface ElevationPromptProps {
    readonly elevation: ElevationBridge | undefined;
}

export function ElevationPrompt({ elevation }: ElevationPromptProps) {
    const [ask, setAsk] = useState<Ask | null>(null);
    const [sending, setSending] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const field = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!elevation) return;
        return elevation.onPrompt((event) => {
            if (event.kind === 'ask') { setAsk(event); setSending(false); setFailed(null); return; }
            setAsk((current) => (current?.id === event.id ? null : current));
        });
    }, [elevation]);

    // The field takes the keyboard when a prompt appears: the person clicked Install a moment ago and expects to type.
    useEffect(() => { if (ask) field.current?.focus(); }, [ask?.id]);

    if (!ask || !elevation) return null;

    const send = (password: string | null): void => {
        setSending(true);
        setFailed(null);
        void elevation.answer(ask.id, password).then((taken) => {
            if (!taken) { setSending(false); setFailed('Genie did not take the answer: the prompt may have expired. Start the step again.'); }
        }, () => { setSending(false); setFailed('Your answer did not reach Genie; check the connection and try again.'); });
    };
    const submit = (e: FormEvent): void => {
        e.preventDefault();
        const input = field.current;
        if (!input || input.value === '') return;
        const password = input.value;
        input.value = '';
        send(password);
    };

    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40">
            <form
                key={ask.id}
                data-elevation-prompt={ask.id}
                role="dialog"
                aria-modal="true"
                aria-labelledby={`elevation-title-${ask.id}`}
                onSubmit={submit}
                className="flex w-[420px] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border border-[var(--warning)] bg-[var(--bg-1)] p-4 text-sm text-[var(--fg-1)] shadow-xl"
            >
                <h2 id={`elevation-title-${ask.id}`} className="text-[15px] font-semibold">{`${ask.title}: your password`}</h2>
                <p>
                    {'Genie needs your administrator password to change '}
                    <span data-elevation-items="" className="font-semibold">{ask.items.join(', ')}</span>
                    {' on this computer. It runs, once:'}
                </p>
                <ul data-elevation-commands="" className="flex flex-col gap-1 rounded-lg bg-[var(--bg-2)] p-2 font-mono text-xs">
                    {ask.commands.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
                {ask.retry ? <p data-elevation-retry="" role="alert" className="text-[var(--danger)]">{`${ask.retry[0]!.toUpperCase()}${ask.retry.slice(1)}. Try again (try ${ask.attempt} of 3).`}</p> : null}
                <input
                    ref={field}
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    aria-label="Your password"
                    data-elevation-password=""
                    disabled={sending}
                    className="rounded-lg border border-[var(--border-1)] bg-[var(--bg-0)] px-3 py-2 text-[13px]"
                />
                <p className="text-xs text-[var(--fg-3)]">Genie hands it to sudo once and does not keep it.</p>
                {failed ? <p data-elevation-failed="" role="alert" className="text-xs text-[var(--danger)]">{failed}</p> : null}
                <div className="flex items-center justify-end gap-2">
                    <Button size="xs" type="button" data-action="elevation-cancel" disabled={sending} onClick={() => { if (field.current) field.current.value = ''; send(null); }} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-[13px] font-medium">
                        Cancel
                    </Button>
                    <Button size="xs" type="submit" data-action="elevation-allow" disabled={sending} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[13px] font-medium text-white">
                        {sending ? 'Checking…' : 'Allow'}
                    </Button>
                </div>
            </form>
        </div>
    );
}
