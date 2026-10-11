import { Icon, Input } from '@particle-academy/react-fancy';
import type { FormEvent } from 'react';
import type { DeckItem } from '../../core/deck.js';
import { ApprovalCard } from './ApprovalCard.js';

/**
 * THE PHONE'S SHELL (§6.8 mobile UI: questions mirrored).
 *
 * One screen, one column, thumb-sized: the loud `● REMOTE — <host>` badge (the same words the
 * desktop wears when it drives another machine), then everything that needs you, answerable in
 * place when answering inline is the whole answer — the SAME approval card as the Deck, so an
 * option reads the same on both screens. A form question is not faked into a button here: it
 * names the screen it belongs to. A forwarded one names its host. `null` items is "not heard yet"
 * and draws a skeleton; `[]` is "nothing needs you" and says so.
 *
 * Before the welcome there is `MobilePair`: the host is the page's own origin (shown, not typed),
 * the PIN is typed unless the QR carried it, and the device gets a name the desktop's roster shows.
 */

export interface MobileShellProps {
    host: string;
    locked: boolean;
    /** The host's last refusal of something this screen did (a write without the baton, a locked host). */
    refusal: string | null;
    /** `null` until the first snapshot arrived. */
    items: readonly DeckItem[] | null;
    answering: string | null;
    onAnswer: (item: DeckItem, optionId: string) => void;
    onDisconnect: () => void;
}

export function MobileShell({ host, locked, refusal, items, answering, onAnswer, onDisconnect }: MobileShellProps) {
    return (
        <div data-mobile="shell" className="flex min-h-dvh flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header className="flex items-center gap-3 border-b border-[var(--border-1)] px-4 py-3">
                <span className="size-5 rounded-[5px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />
                <span data-remote-badge className="rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-xs font-semibold tracking-wide text-amber-500">● REMOTE — {host}</span>
                <span className="flex-1" />
                <button type="button" data-action="disconnect" onClick={onDisconnect} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-xs">Disconnect</button>
            </header>

            {locked ? (
                <p data-locked className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-amber-500">{host} is locked: every change from here is refused until it is unlocked there. Reading still works.</p>
            ) : null}
            {refusal ? (
                <p data-refusal className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-red-500">{refusal}</p>
            ) : null}

            <main className="flex flex-1 flex-col gap-3 px-4 py-3">
                <h1 className="text-sm font-semibold">Needs you</h1>
                {items === null ? (
                    <div data-mobile-items="loading" className="flex flex-col gap-2" aria-busy>
                        <div className="h-16 animate-pulse rounded-xl bg-[var(--bg-2)]" />
                        <div className="h-16 animate-pulse rounded-xl bg-[var(--bg-2)]" />
                    </div>
                ) : items.length === 0 ? (
                    <p data-mobile-items="clear" className="py-8 text-center text-[13px] text-[var(--fg-3)]">Nothing needs you.</p>
                ) : (
                    <ul data-mobile-items={items.length} className="flex flex-col gap-3">
                        {items.map((item) => (
                            <li key={item.id} data-mobile-item={item.id} className="rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-3">
                                <div className="flex items-center gap-2 text-xs text-[var(--fg-3)]">
                                    {item.blocking ? <span className="size-2 rounded-full bg-amber-500" aria-label="blocking" /> : null}
                                    <span className="font-medium text-[var(--fg-1)]">{item.agentName ?? item.workspaceId}</span>
                                    <span className="font-mono">{item.workspaceId}</span>
                                </div>
                                {item.answer.kind === 'inline' ? (
                                    <ApprovalCard approval={{ question: item.title, options: item.answer.options }} answering={answering} onAnswer={(optionId) => onAnswer(item, optionId)} />
                                ) : (
                                    <p className="mt-1 text-[13px]">{item.title}</p>
                                )}
                                {item.answer.kind === 'form' ? (
                                    <p data-mobile-elsewhere={host} className="mt-2 flex items-center gap-1.5 text-xs text-[var(--fg-3)]">
                                        <Icon name="list-checks" size="xs" />
                                        {item.answer.fields} questions — answer them on {host}’s screen.
                                    </p>
                                ) : null}
                                {item.answer.kind === 'elsewhere' ? (
                                    <p data-deck-elsewhere={item.answer.host} className="mt-2 text-xs text-[var(--fg-3)]">
                                        Raised on <span className="font-mono text-[var(--fg-2)]">{item.answer.host}</span>, and it has to be answered there.
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </main>
        </div>
    );
}

export interface MobilePairProps {
    /** The page's own origin — where the socket is. Shown, never typed. */
    host: string;
    refusal: string | null;
    connecting: boolean;
    onConnect: (input: { pin: string; label: string }) => void;
}

export function MobilePair({ host, refusal, connecting, onConnect }: MobilePairProps) {
    const submit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        onConnect({ pin: String(data.get('pin') ?? ''), label: String(data.get('label') ?? '') });
    };
    return (
        <div data-mobile="pair" className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[var(--bg-0)] px-6 text-[var(--fg-1)]">
            <span className="size-10 rounded-[10px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />
            <h1 className="text-base font-semibold">Pair with <span className="font-mono">{host}</span></h1>
            <p className="text-center text-[13px] text-[var(--fg-3)]">Type the PIN that machine shows under Settings → Workstation → Remote access. It is good for two minutes.</p>
            <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
                <Input name="pin" inputMode="numeric" autoComplete="one-time-code" placeholder="482913" aria-label="PIN" className="text-center font-mono text-lg tracking-[0.3em]" />
                <Input name="label" defaultValue="phone" aria-label="This device’s name" />
                {refusal ? <p data-refusal className="text-xs text-red-500">{refusal}</p> : null}
                <button type="submit" disabled={connecting} className="rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-60">{connecting ? 'Connecting…' : 'Connect'}</button>
            </form>
        </div>
    );
}
