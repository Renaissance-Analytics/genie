import { useState } from 'react';
import { Button, QrCode } from '@particle-academy/react-fancy';
import { MAGICDNS_SETTINGS, TAILSCALE_APP_STORE, TAILSCALE_GOOGLE_PLAY, phoneAddress } from '../../core/pairing-guide.js';
import type { FeatureAction, RemoteSection } from '../features.js';
import { PairPin } from './PairPin.js';

/**
 * PAIR A DEVICE, AS A PERSON DOES IT (Tynn #750, #752). The phone needs the Tailscale app, signed in to the same account,
 * before it can open Genie: the first pairing says so first, with the two store QRs, and the PIN comes after (a PIN
 * shown first ran out while the app was being set up, Tynn #751). The address shown is the page the phone keeps, by its
 * MagicDNS name, never the socket; a tailnet without MagicDNS is told how to get a name.
 */
export function PairGuide({ remote, pairUrl, now, onAction, button }: {
    remote: RemoteSection & { url: string };
    pairUrl: string;
    now?: number | undefined;
    onAction: (action: FeatureAction) => void;
    button: string;
}) {
    const [appStep, setAppStep] = useState(false);
    const address = phoneAddress(remote.url);
    const pin = () => { setAppStep(false); onAction({ kind: 'remote.issuePin' }); };
    // Someone who has paired a phone before has the app: no extra step for them.
    const firstPhone = remote.devices.length === 0;
    const showStep = appStep && remote.pin === null;
    return (
        <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
                <span data-phone-address={address?.url ?? remote.url} className="select-all font-mono text-xs text-[var(--fg-4)]">{address?.url ?? remote.url}</span>
                {address && !address.named ? (
                    <span data-magicdns="off" className="flex items-center gap-1 text-xs text-[var(--fg-3)]">
                        No name to bookmark:
                        <Button variant="ghost" size="xs" href={MAGICDNS_SETTINGS} target="_blank" rel="noreferrer" className="h-auto p-0 text-xs text-[var(--accent)] underline">turn on MagicDNS</Button>
                    </span>
                ) : null}
                <Button size="xs" type="button" data-action="pair-device" className={button} onClick={() => (firstPhone && remote.pin === null ? setAppStep(true) : pin())}>Pair a device</Button>
                {/* The PIN, its time left, and New PIN in place when it lapses (Tynn #751). */}
                {showStep ? null : <PairPin pin={remote.pin} pinEnded={remote.pinEnded ?? null} pairUrl={pairUrl} now={now} onAction={onAction} />}
                {remote.pin ? (
                    <span data-store-links="" className="basis-full text-xs text-[var(--fg-3)]">
                        No Tailscale on the phone? <StoreLink href={TAILSCALE_APP_STORE}>App Store</StoreLink> · <StoreLink href={TAILSCALE_GOOGLE_PLAY}>Google Play</StoreLink>
                    </span>
                ) : null}
            </div>
            {showStep ? (
                <div data-pair-step="app" className="flex flex-wrap items-end gap-4 rounded-xl border border-[var(--border-1)] p-3">
                    <p className="basis-full">On the phone: Tailscale, signed in to the same Tailscale account. Keep it on, on both.</p>
                    <StoreQr label="iPhone" href={TAILSCALE_APP_STORE} />
                    <StoreQr label="Android" href={TAILSCALE_GOOGLE_PLAY} />
                    <Button size="xs" type="button" data-action="pair-next" className={button} onClick={pin}>Next: the PIN</Button>
                </div>
            ) : null}
        </div>
    );
}

function StoreLink({ href, children }: { href: string; children: string }) {
    return <Button variant="ghost" size="xs" href={href} target="_blank" rel="noreferrer" className="inline h-auto p-0 align-baseline text-xs text-[var(--accent)] underline">{children}</Button>;
}

/** One store: its QR for the phone's camera, and the link for a click on this machine. */
function StoreQr({ label, href }: { label: string; href: string }) {
    return (
        <div data-qr-value={href} className="flex flex-col items-center gap-1">
            <div className="rounded-xl bg-white p-2">
                <QrCode value={href} label={`Tailscale for ${label}`} size={96} errorCorrection="M" quietZone={4} foreground="#0b0b0c" background="#ffffff" />
            </div>
            <StoreLink href={href}>{label}</StoreLink>
        </div>
    );
}
