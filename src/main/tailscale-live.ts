/**
 * TAILSCALE, LIVE (Tynn #748, #749). RED STUB: inert. Passes Install and Connect straight through, reads nothing, watches
 * nothing. The implementation follows.
 */
import type { TailscaleStatus, TailscaleUpResult } from './tailscale-cli.js';

export interface InstallAnswer { readonly started: boolean; readonly url?: string; readonly message?: string }

export interface TailscaleLivePorts {
    readonly probe: () => Promise<TailscaleStatus>;
    readonly install: () => Promise<InstallAnswer>;
    readonly up: () => Promise<TailscaleUpResult>;
    readonly online: () => Promise<void>;
    readonly changed: () => void;
    readonly timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
    readonly now?: () => number;
    readonly everyMs?: number;
    readonly forMs?: number;
}

export interface TailscaleLive {
    status(): TailscaleStatus | null;
    refresh(): Promise<TailscaleStatus | null>;
    look(): Promise<TailscaleStatus | null>;
    install(): Promise<InstallAnswer>;
    up(): Promise<TailscaleUpResult>;
    stop(): void;
}

export function tailscaleLive(ports: TailscaleLivePorts): TailscaleLive {
    return {
        status: () => null,
        refresh: async () => null,
        look: async () => null,
        install: () => ports.install(),
        up: () => ports.up(),
        stop: () => {},
    };
}
