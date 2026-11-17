import type { PhonePlatform } from '../../core/pairing-guide.js';

/**
 * KEEP GENIE ON THIS PHONE (Tynn #752). Shown once, right after a PIN pairing: the address to come back to (the MagicDNS
 * name the phone opened, never a typed IP), the browser's own "Add to Home Screen", and that Tailscale stays on on both.
 */
export interface MobileKeepProps {
    readonly address: string;
    readonly platform: PhonePlatform;
    readonly onDone: () => void;
}

export function MobileKeep(_props: MobileKeepProps) {
    return null;
}
