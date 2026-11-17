import { mobilePageUrl } from './mobile.js';

/**
 * PAIRING A PHONE, END TO END (Tynn #750, #752). At the client call the phone needed the Tailscale app before it could
 * open Genie, and Pair a device said nothing about it; after pairing, nothing gave the phone an address to come back to,
 * so the person bookmarked a raw IP by hand and mistyped it twice. These are the pure decisions behind the guide.
 */

/** Tailscale's own store listings, as Tailscale's download pages link them (tailscale.com/download/ios, /android). */
export const TAILSCALE_APP_STORE = 'https://apps.apple.com/us/app/tailscale/id1470499037';
export const TAILSCALE_GOOGLE_PLAY = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn';
/** Where a tailnet turns MagicDNS on (tailscale.com/kb/1081/magicdns: "the DNS page of the admin console"). */
export const MAGICDNS_SETTINGS = 'https://console.tailscale.com/admin/dns';

/**
 * The address a phone keeps: the page on the listener's port, by the MagicDNS name. `named` false = the listener could
 * only give its 100.x address (MagicDNS off on the tailnet), which works but is no name to bookmark.
 */
export function phoneAddress(socketUrl: string | null): { url: string; named: boolean } | null {
    const url = mobilePageUrl(socketUrl);
    if (!url) return null;
    const host = new URL(url).hostname;
    return { url, named: !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.startsWith('[') };
}

/** Which "Add to Home Screen" a phone's browser has. */
export type PhonePlatform = 'ios' | 'android' | 'other';
export function phonePlatform(userAgent: string): PhonePlatform {
    if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return 'ios';
    if (/\bAndroid\b/.test(userAgent)) return 'android';
    return 'other';
}

/** After a PIN pairing, the phone is shown how to keep Genie, once, unless it already runs from the home screen. */
export function offerKeep(input: { pairedWithPin: boolean; standalone: boolean; dismissed: boolean }): boolean {
    return input.pairedWithPin && !input.standalone && !input.dismissed;
}
