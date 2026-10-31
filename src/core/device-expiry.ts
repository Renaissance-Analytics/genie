/**
 * HOW LONG A PAIRED DEVICE STAYS PAIRED, AND THE NOTICE BEFORE IT ENDS (the owner, 2026-10-31, q_8c07b142).
 *
 * A pairing lasts DEVICE_EXPIRY_DAYS without a connection, sliding: every connection from the device renews it, so a
 * phone in use never re-pairs, and a lost one stops working on its own. Within DEVICE_EXPIRY_WARNING_DAYS of the end, a
 * yellow ! on the Settings row and on the device's row says which device and when, so the person can renew it (connect
 * from it) or Re-pair it before it lapses. Pure: the clock is the caller's.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** A pairing unused for this many days is gone; the device must pair again (genie#1349 had 30). */
export const DEVICE_EXPIRY_DAYS = 90;
/** The yellow ! appears this many days before a pairing expires. */
export const DEVICE_EXPIRY_WARNING_DAYS = 14;

export interface ExpiringDevice {
    readonly id: string;
    readonly label: string;
    /** ISO time the pairing lapses unless the device connects first. */
    readonly expiresAt: string;
}

export interface DeviceExpiryWarning extends ExpiringDevice {
    /** The tooltip: the device, the date, and how to renew it. */
    readonly text: string;
}

export interface DeviceExpiryAlert {
    /** Every warned device in one sentence set — the Settings row's tooltip. */
    readonly label: string;
    /** Soonest first. */
    readonly devices: readonly DeviceExpiryWarning[];
}

/** `timeZone` is for tests; absent, the date is this machine's local date. */
export interface ExpiryFormat {
    readonly timeZone?: string;
}

function dateWords(iso: string, format: ExpiryFormat): string {
    if (Number.isNaN(Date.parse(iso))) return 'an unknown date';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(format.timeZone ? { timeZone: format.timeZone } : {}) }).format(new Date(iso));
}

const RENEW = 'Re-pair it in Settings → Remote access.';

function expiresSentence(label: string, expiresAt: string, format: ExpiryFormat): string {
    return `The pairing for ${label} expires on ${dateWords(expiresAt, format)}.`;
}

/** The tooltip for one device. */
export function deviceExpiryText(label: string, expiresAt: string, format: ExpiryFormat = {}): string {
    return `${expiresSentence(label, expiresAt, format)} Connect from that device to renew it, or ${RENEW}`;
}

/** Whether a device's pairing is within the warning window (and not already over). */
export function isExpiringSoon(expiresAt: string, now: number): boolean {
    const left = Date.parse(expiresAt) - now;
    return left > 0 && left <= DEVICE_EXPIRY_WARNING_DAYS * DAY_MS;
}

/** The devices close to their end, soonest first, or `null` when none is — the mark is then not drawn at all. */
export function deviceExpiryAlert(devices: readonly ExpiringDevice[], now: number, format: ExpiryFormat = {}): DeviceExpiryAlert | null {
    const close = devices.filter((d) => isExpiringSoon(d.expiresAt, now)).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    if (close.length === 0) return null;
    const warned = close.map((d) => ({ id: d.id, label: d.label, expiresAt: d.expiresAt, text: deviceExpiryText(d.label, d.expiresAt, format) }));
    const label = warned.length === 1 ? warned[0]!.text : `${close.map((d) => expiresSentence(d.label, d.expiresAt, format)).join(' ')} Connect from each device to renew it, or ${RENEW}`;
    return { label, devices: warned };
}
