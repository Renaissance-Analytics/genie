import { FrameJoiner, framePieces } from '../core/device-frames.js';
import type { WorkstationRole } from '../core/workstation-role.js';
import { deviceLinkGate } from './device-link-gate.js';
import { isGenHost } from './relay-site.js';
import { DEVICE_FRAME_LIMIT_BYTES, type DeviceLinkEvent, type DeviceLinkOpened, type RelayOpened } from './device-link-service.js';

/**
 * A REMOTE WINDOW'S TRANSPORT TO ANOTHER MACHINE, ON THE ONE PROTOCOL (Tynn #941, client/host split step 2f-2). A client is
 * a dumb terminal: the socket to another machine (a device socket, or a Tynn workstation's relay) is genie-host's device
 * link (device-link-service.ts), and the window reaches it over ITS OWN protocol connection, `deviceLink.open` /
 * `openRelay` / `send` / `close` / `openBrowser`. The owner of what a call opens is that connection: only it may use or
 * close it, it hears its frames alone (`local-device`, RemoteHost eventTo), and what it opened closes when it goes.
 *
 * - A dial is refused for a drone here, from the role genie-host read from Tynn, before any socket (device-link-gate.ts,
 *   as main's window did; audit M-b). A relay's Tynn refusal is worded from a role read again (genie#1278 M0 finding 3).
 * - A frame crosses the window's door in pieces, both ways (core/device-frames.ts): joined here before the socket hears
 *   it, and cut here before the window does.
 * - The relay browser: THIS machine's Genie browser on the caller's own relay channel's workstation, opened by genie-host
 *   with that workstation's door; the door moving reaches the browser from here, never through a window.
 */
export interface DeviceLinkProtocolPorts {
    readonly link: {
        open(owner: string, url: string): Promise<DeviceLinkOpened>;
        openRelay(owner: string, workstationId: string): Promise<RelayOpened>;
        send(owner: string, channel: string, text: string): void;
        close(owner: string, channel: string): void;
        dropOwner(owner: string): void;
        browserVia(owner: string, channel: string): Promise<{ ok: true; workstationId: string; port: number; ca: string | null } | { ok: false; reason: string }>;
    };
    /** This machine's Pilot/Drone role as genie-host read it from Tynn, and a fresh read (device-link-gate.ts). */
    readonly role: { role(): WorkstationRole | null; said(): WorkstationRole | null; why(): string | null; reread(): Promise<void> };
    /** Tynn refused the grant: the words, from the role read again (drone-refusal.ts wordTynnRefusal). */
    readonly wordTynnRefusal: (refusal: { ok: false; reason: string; refusedByTynn?: true }) => Promise<{ ok: false; reason: string }>;
    /** Genie's browser process's `open` (browser-service.ts): [address, activation, remote, anchor]. */
    readonly openBrowser: (args: unknown[]) => Promise<unknown>;
    /** A relay workstation's browser door moved, or learned that host's CA: the browser's to hear (browser-service.ts). */
    readonly remoteVia: (key: string, port: number, ca: string | null) => void;
}

/** What a window is told of its channels: a frame's piece (`more` until its last), a close, a relay's step. */
export type DeviceLinkPush =
    | { readonly type: 'frame'; readonly channel: string; readonly text: string; readonly more?: true }
    | { readonly type: 'closed'; readonly channel: string; readonly reason: string | null }
    | { readonly type: 'step'; readonly workstationId: string; readonly step: 'relay' };

export interface DeviceLinkProtocol {
    /** `owner`: the calling protocol connection. */
    call(owner: string, method: string, args: readonly unknown[]): Promise<unknown>;
    /** That connection went: everything it opened closes. */
    dropOwner(owner: string): void;
    /** What the device link said, as the owning window hears it: a frame in pieces, nothing of a moved browser door. */
    events(event: DeviceLinkEvent): DeviceLinkPush[];
}

const NOT_A_DEVICE = 'another machine is reached over ws:// or wss://';
const TITLE_MAX = 200;

/** The asking window's place on screen, cosmetic: where the browser window opens over it (Tynn #739). */
function anchorOf(raw: unknown): { x: number; y: number; width: number; height: number } | null {
    const a = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    if (!a || typeof a !== 'object') return null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
    const x = n(a.x), y = n(a.y), width = n(a.width), height = n(a.height);
    return x === null || y === null || width === null || height === null || width <= 0 || height <= 0 ? null : { x, y, width, height };
}

export function deviceLinkProtocol(ports: DeviceLinkProtocolPorts): DeviceLinkProtocol {
    // Each owner's channels' half-sent frames, kept apart: `<owner>\u0000<channel>`.
    const joiner = new FrameJoiner(DEVICE_FRAME_LIMIT_BYTES);
    const key = (owner: string, channel: string) => `${owner}\u0000${channel}`;
    // Which workstation each relay channel's browser reaches, once the browser was opened on it (its door may move).
    const browsing = new Map<string, string>();
    return {
        async call(owner, method, args) {
            switch (method) {
                case 'open': {
                    const url = args[0];
                    if (typeof url !== 'string' || !/^wss?:\/\/./i.test(url)) return { ok: false, reason: NOT_A_DEVICE };
                    return deviceLinkGate(url, { ...ports.role, link: () => ({ open: (u: string) => ports.link.open(owner, u) }) });
                }
                case 'openRelay': {
                    const opened = await ports.link.openRelay(owner, String(args[0] ?? ''));
                    if (opened.ok || !('refusal' in opened)) return opened;
                    // Where it failed (core/relay-connect.ts): Tynn's way in, worded from a role read again.
                    return { ...(await ports.wordTynnRefusal(opened.refusal)), stage: 'tynn' };
                }
                case 'send': {
                    const channel = String(args[0] ?? '');
                    const joined = joiner.add(key(owner, channel), String(args[1] ?? ''), args[2] === true);
                    if (joined === null) return true;
                    if (!joined.ok) { ports.link.close(owner, channel); return { ok: false, reason: joined.reason }; }
                    ports.link.send(owner, channel, joined.text);
                    return true;
                }
                case 'close': {
                    const channel = String(args[0] ?? '');
                    joiner.drop(key(owner, channel));
                    browsing.delete(channel);
                    ports.link.close(owner, channel);
                    return true;
                }
                case 'openBrowser': {
                    const channel = String(args[0] ?? '');
                    const via = await ports.link.browserVia(owner, channel);
                    if (!via.ok) return { ok: false, error: via.reason };
                    browsing.set(channel, via.workstationId);
                    const address = typeof args[1] === 'string' ? args[1] : null;
                    const hosts = Array.isArray(args[2]) ? args[2].filter(isGenHost) : [];
                    const view = (args[3] ?? {}) as { title?: unknown; anchor?: unknown };
                    const title = typeof view.title === 'string' && view.title.trim() !== '' ? view.title.slice(0, TITLE_MAX) : 'another workstation';
                    try {
                        await ports.openBrowser([address, 'user-gesture', { key: `relay:${via.workstationId}`, title, port: via.port, ca: via.ca, hosts }, anchorOf(view.anchor)]);
                        return { ok: true };
                    } catch (error) {
                        return { ok: false, error: error instanceof Error ? error.message : String(error) };
                    }
                }
                default:
                    throw new Error(`the device link has no ${method}`);
            }
        },
        dropOwner(owner) {
            joiner.dropPrefix(`${owner}\u0000`);
            ports.link.dropOwner(owner);
        },
        events(event) {
            if (event.type === 'via') {
                const workstationId = browsing.get(event.channel);
                if (workstationId) ports.remoteVia(`relay:${workstationId}`, event.port, event.ca);
                return [];
            }
            if (event.type === 'closed') { browsing.delete(event.channel); return [{ type: 'closed', channel: event.channel, reason: event.reason }]; }
            if (event.type === 'step') return [{ type: 'step', workstationId: event.workstationId, step: event.step }];
            const pieces = framePieces(event.text);
            return pieces.map((text, i) => (i < pieces.length - 1 ? { type: 'frame' as const, channel: event.channel, text, more: true as const } : { type: 'frame' as const, channel: event.channel, text }));
        },
    };
}

