import { useEffect, useRef, useState } from 'react';
import { Action, Icon, Text } from '@particle-academy/react-fancy';
import { pair } from '../../lib/mobile-client';

/**
 * First screen the phone sees with no session token: a 6-digit PIN entry that
 * exchanges for a session token via `POST /api/pair`. Because the desktop pops
 * a confirm modal, that request BLOCKS until the user accepts on the desktop —
 * so while it's in flight we show "Waiting for desktop confirmation…" rather
 * than a spinner that looks stuck.
 *
 * The PIN auto-fills from a `?pair=<pin>` query param (the QR the desktop shows
 * encodes `…/m/?pair=<pin>`), so scanning the code lands here pre-filled and
 * the user just taps Pair → confirms on the desktop.
 */
export default function PairScreen({ onPaired }: { onPaired: () => void }) {
    const [pin, setPin] = useState('');
    const [waiting, setWaiting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Auto-fill the PIN from the QR deep-link (`?pair=123456`).
    useEffect(() => {
        try {
            const fromQuery = new URLSearchParams(window.location.search).get('pair');
            if (fromQuery) setPin(fromQuery.replace(/\D/g, '').slice(0, 6));
        } catch {
            /* malformed URL — user types it */
        }
        inputRef.current?.focus();
    }, []);

    const submit = async () => {
        if (waiting || pin.length < 6) return;
        setWaiting(true);
        setError(null);
        const result = await pair(pin);
        setWaiting(false);
        if (result.ok) {
            onPaired();
        } else {
            setError(result.message);
            // Rate-limited / wrong PIN: keep the digits so the user can edit.
            if (result.reason === 'wrong-pin') {
                setPin('');
                inputRef.current?.focus();
            }
        }
    };

    return (
        <div className="m-pair">
            <div className="m-pair-card">
                <div className="m-pair-logo">
                    <Icon name="sparkles" size="lg" className="text-violet-500" />
                </div>
                <Text size="lg" style={{ fontWeight: 700, textAlign: 'center' }}>
                    Pair with Genie
                </Text>
                <Text size="sm" className="text-zinc-500" style={{ textAlign: 'center' }}>
                    Enter the 6-digit PIN shown in Genie&apos;s Mobile settings.
                </Text>

                <input
                    ref={inputRef}
                    className="m-pin-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="000000"
                    value={pin}
                    disabled={waiting}
                    onChange={(e) => {
                        setError(null);
                        setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void submit();
                    }}
                />

                {waiting ? (
                    <div className="m-pair-waiting">
                        <Icon name="loader" size="sm" className="m-spin" />
                        <Text size="sm" className="text-zinc-500">
                            Waiting for desktop confirmation…
                        </Text>
                    </div>
                ) : (
                    <Action
                        color="blue"
                        icon="smartphone"
                        onClick={() => void submit()}
                        disabled={pin.length < 6}
                    >
                        Pair this device
                    </Action>
                )}

                {error && (
                    <div className="m-pair-error">
                        <Icon name="alert-triangle" size="xs" />
                        <Text size="xs">{error}</Text>
                    </div>
                )}
            </div>
        </div>
    );
}
