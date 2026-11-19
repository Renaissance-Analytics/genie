import { Fragment } from 'react';
import type { ProviderDetail } from '../../core/provider-stops.js';

/**
 * THE PROVIDER'S OWN WORDS ON A STOP LINE (Tynn #921, prism-acp 0.43.0 G-311): its message as a quote marked as the
 * provider's, apart from Genie's own sentence, and the details that help. The text is UNTRUSTED (prism bounds it, marks
 * hidden characters and redacts an echoed key); React renders it as text, never markup. Nothing to show = nothing drawn.
 */
export function ProviderQuote({ message, details }: { message?: string | null | undefined; details?: readonly ProviderDetail[] | undefined }) {
    const list = details ?? [];
    if (!message && list.length === 0) return null;
    return (
        <figure data-provider-quote="" className="mt-1.5 font-sans text-[12px]">
            <figcaption className="text-[11px] text-[var(--fg-3)]">The provider wrote (quoted as sent, not checked by Genie):</figcaption>
            {message ? (
                <blockquote data-provider-message="" className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words border-l-2 border-[var(--border-1)] pl-2 text-[var(--fg-2)]">{message}</blockquote>
            ) : null}
            {list.length > 0 ? (
                <dl data-provider-details="" className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11px]">
                    {list.map((d) => (
                        <Fragment key={d.key}>
                            <dt className="text-[var(--fg-3)]">{d.label}</dt>
                            <dd data-provider-detail={d.key} className="break-words text-[var(--fg-2)]">{String(d.value)}</dd>
                        </Fragment>
                    ))}
                </dl>
            ) : null}
        </figure>
    );
}
