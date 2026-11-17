import { useEffect, useState } from 'react';
import { Button, QrCode } from '@particle-academy/react-fancy';
import type { PinEnded } from '../../core/remote.js';
import type { FeatureAction } from '../features.js';

/**
 * THE PIN ON THIS SCREEN, WITH ITS CLOCK (Tynn #751). A PIN lives two minutes; at the client call it ran out while the
 * phone was being set up, the desktop said nothing, and the phone was told "no PIN is active". The time left shows beside
 * the code, and when it lapses the QR's place says so with a New PIN button, in the same footprint (no jump).
 */

/** "1:42": what is left of a PIN, from the host's `expiresAt`; "0:00" once it has passed. */
export function pinTimeLeft(expiresAt: number, now: number): string {
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The one slot the QR and its ending share: the QR's 128 px and padding, so neither state moves what is below. */
const SLOT = 'flex h-[152px] w-[152px] items-center justify-center';

export function PairPin({ pin, pinEnded, pairUrl, now, onAction }: {
    pin: { code: string; expiresAt: number } | null;
    pinEnded?: PinEnded | null | undefined;
    pairUrl: string;
    now?: number | undefined;
    onAction: (action: FeatureAction) => void;
}) {
    const [clock, setClock] = useState(() => now ?? Date.now());
    // A new render with a newer `now` (the window's own redraws) moves the clock forward, never back.
    useEffect(() => { if (now !== undefined) setClock((c) => Math.max(c, now)); }, [now]);
    const code = pin?.code ?? null;
    useEffect(() => {
        if (code === null) return;
        setClock(Date.now());
        const t = setInterval(() => setClock(Date.now()), 1000);
        return () => clearInterval(t);
    }, [code]);

    // This window's clock past the expiry reads as expired before the host's own push arrives: never a dead code at 0:00.
    const ended: PinEnded | null = pinEnded ?? (pin && clock >= pin.expiresAt ? { reason: 'expired', at: pin.expiresAt } : null);
    if (pin && !ended) {
        const value = `${pairUrl}#pin=${pin.code}`;
        return (
            <>
                <span className="flex items-center gap-2">
                    <span data-pin={pin.code} className="font-mono text-lg tracking-[0.3em]">{pin.code}</span>
                    <span data-pin-left={pinTimeLeft(pin.expiresAt, clock)} className="inline-block min-w-[4ch] font-mono text-xs tabular-nums text-[var(--fg-3)]">{pinTimeLeft(pin.expiresAt, clock)}</span>
                </span>
                {/* A phone scans the page URL and the PIN together; both stay beside it as text (a code is an image of a value). */}
                <div data-pairing-qr data-qr-value={value} className="basis-full">
                    <div data-pair-slot="qr" className={SLOT}>
                        <div className="rounded-xl bg-white p-2">
                            <QrCode value={value} label="Pair this device" size={128} errorCorrection="M" quietZone={4} foreground="#0b0b0c" background="#ffffff" />
                        </div>
                    </div>
                </div>
            </>
        );
    }
    if (!ended) return null;
    const replaces = pin ? null : (ended.replaces ?? null);
    return (
        <div data-pin-ended={ended.reason} className="basis-full">
            <div data-pair-slot="ended" className={SLOT}>
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-1)] text-sm">
                    <span className="text-[var(--fg-2)]">{ended.reason === 'cancelled' ? 'Too many wrong tries' : 'PIN expired'}</span>
                    <Button size="xs" type="button" data-action="new-pin" onClick={() => onAction(replaces ? { kind: 'remote.issuePin', replaces } : { kind: 'remote.issuePin' })}>New PIN</Button>
                </div>
            </div>
        </div>
    );
}
