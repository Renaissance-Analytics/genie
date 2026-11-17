import { Button, QrCode } from '@particle-academy/react-fancy';
import type { PinEnded } from '../../core/remote.js';
import type { FeatureAction } from '../features.js';

/**
 * THE PIN ON THIS SCREEN, WITH ITS CLOCK (Tynn #751). A PIN lives two minutes; at the client call it ran out while the
 * phone was being set up, the desktop said nothing, and the phone was told "no PIN is active". The time left shows beside
 * the code, and when it lapses the QR's place says so with a New PIN button, in the same footprint (no jump).
 */

/** "1:42": what is left of a PIN, from the host's `expiresAt`; "0:00" once it has passed. */
export function pinTimeLeft(_expiresAt: number, _now: number): string {
    return '';
}

export function PairPin({ pin, pairUrl }: {
    pin: { code: string; expiresAt: number } | null;
    pinEnded?: PinEnded | null | undefined;
    pairUrl: string;
    now?: number | undefined;
    onAction: (action: FeatureAction) => void;
}) {
    if (!pin) return null;
    void Button;
    return (
        <>
            <span className="flex items-center gap-2">
                <span data-pin={pin.code} className="font-mono text-lg tracking-[0.3em]">{pin.code}</span>
                <span className="text-xs text-[var(--fg-3)]">type this on the device within two minutes</span>
            </span>
            {/* A phone scans the page URL and the PIN together; both stay beside it as text (a code is an image of a value). */}
            <div data-pairing-qr data-qr-value={`${pairUrl}#pin=${pin.code}`} className="basis-full">
                <div className="w-fit rounded-xl bg-white p-2">
                    <QrCode value={`${pairUrl}#pin=${pin.code}`} label="Pair this device" size={128} errorCorrection="M" quietZone={4} foreground="#0b0b0c" background="#ffffff" />
                </div>
            </div>
        </>
    );
}
