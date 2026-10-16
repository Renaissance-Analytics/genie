import { describe, expect, it } from 'vitest';
import { Baton, PairingPins, ShareLinks, splitSettings, type SettingDefinition } from '../src/core/remote.js';

/**
 * REMOTE, PAIRING, SHARING (§6.8) — the pure half. Every rule here was paid for in v1:
 *
 * - the BATON: exactly one driver; a READ is never gated on it; an UPGRADE is gated on ownership
 *   of the host, not on the baton;
 * - SHARE LINKS: the URL is served exactly once and never re-served — a link is a credential you
 *   cannot unsend; a link for another host is refused;
 * - PAIRING by PIN: short-lived, attempt-capped, one use;
 * - the THREE-WAY SPLIT of settings: device/UI preferences are client-local, workspace/agent
 *   environment is host-sourced, everything else host-only — DERIVED from the registry, never an
 *   explicit list (an explicit list missed two providers for two releases).
 */

describe('the baton — exactly one driver', () => {
    it('the first client to take it drives; a second is told who has it; the holder can pass or release', () => {
        const b = new Baton();
        expect(b.take('conn_a', 'studio')).toEqual({ ok: true, driver: 'conn_a' });
        expect(b.take('conn_b', 'phone')).toEqual({ ok: false, driver: 'conn_a', driverLabel: 'studio' });
        expect(b.holder()).toEqual({ connectionId: 'conn_a', label: 'studio' });
        expect(b.release('conn_b')).toBe(false);
        expect(b.release('conn_a')).toBe(true);
        expect(b.take('conn_b', 'phone')).toEqual({ ok: true, driver: 'conn_b' });
    });

    it('a READ is never gated on the baton; a WRITE is; an UPGRADE is gated on host OWNERSHIP, not the baton', () => {
        const b = new Baton();
        b.take('conn_a', 'studio');
        expect(b.may('conn_b', 'read')).toEqual({ ok: true });
        expect(b.may('conn_b', 'write')).toEqual({ ok: false, reason: 'studio is driving; take the baton to make changes' });
        expect(b.may('conn_a', 'write')).toEqual({ ok: true });
        // The owner on another connection may upgrade without the baton; the driver who is not the owner may not.
        expect(b.may('conn_b', 'upgrade', { isOwner: true })).toEqual({ ok: true });
        expect(b.may('conn_a', 'upgrade', { isOwner: false })).toEqual({ ok: false, reason: 'only the host owner may upgrade this Genie' });
    });

    it('a dropped connection releases the baton it held, and nobody else’s', () => {
        const b = new Baton();
        b.take('conn_a', 'studio');
        b.connectionLost('conn_b');
        expect(b.holder()?.connectionId).toBe('conn_a');
        b.connectionLost('conn_a');
        expect(b.holder()).toBeNull();
    });

    it('lock is a kill-switch: nobody writes until unlocked by the owner, the driver included', () => {
        const b = new Baton();
        b.take('conn_a', 'studio');
        b.lock();
        expect(b.may('conn_a', 'write')).toEqual({ ok: false, reason: 'this Genie is locked' });
        expect(b.may('conn_a', 'read')).toEqual({ ok: true });
        b.unlock();
        expect(b.may('conn_a', 'write')).toEqual({ ok: true });
    });
});

describe('share links — a credential you cannot unsend', () => {
    let clock = 1_000_000;
    const now = () => clock;

    it('mints a link for THIS host with a one-time secret, and serves the URL exactly once', () => {
        const links = new ShareLinks({ host: 'studio.tailnet.invalid', now, random: () => 'r4nd0m' });
        const link = links.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 3_600_000 });
        expect(link.id).toMatch(/^share_/);
        const first = links.serve(link.id);
        expect(first).toEqual({ ok: true, url: 'https://studio.tailnet.invalid/share/share_r4nd0m#r4nd0m' });
        // COUNTED: a second serve is refused — the URL is gone from the server the moment it was shown.
        expect(links.serve(link.id)).toEqual({ ok: false, reason: 'this link was already served once and cannot be shown again; mint a new one' });
        expect(links.roster().map((r) => [r.id, r.grantedTo, r.served])).toEqual([[link.id, 'wren', true]]);
    });

    it('redeems with the secret while unexpired and unrevoked; a wrong secret, an expired or a revoked link all refuse', () => {
        const links = new ShareLinks({ host: 'studio.tailnet.invalid', now, random: () => 's3cret' });
        const link = links.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 1_000 });
        expect(links.redeem(link.id, 'wrong')).toEqual({ ok: false, reason: 'not a valid link' });
        expect(links.redeem(link.id, 's3cret')).toEqual({ ok: true, workspaceId: 'tynn', grantedTo: 'wren' });
        clock += 2_000;
        expect(links.redeem(link.id, 's3cret')).toEqual({ ok: false, reason: 'this link expired' });
        const other = links.mint({ workspaceId: 'tynn', grantedTo: 'kai', expiresInMs: 60_000 });
        links.revoke(other.id);
        expect(links.redeem(other.id, 's3cret')).toEqual({ ok: false, reason: 'this link was revoked' });
    });

    it('a link minted for another host is refused at redemption, by host', () => {
        const a = new ShareLinks({ host: 'studio.tailnet.invalid', now, random: () => 'x' });
        const b = new ShareLinks({ host: 'laptop.tailnet.invalid', now, random: () => 'x' });
        const link = a.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 60_000 });
        expect(b.redeem(link.id, 'x')).toEqual({ ok: false, reason: 'not a valid link' });
        expect(ShareLinks.hostOf(a.serve(link.id).ok ? 'https://studio.tailnet.invalid/share/share_x#x' : '')).toBe('studio.tailnet.invalid');
    });
});

describe('pairing by PIN', () => {
    let clock = 0;
    const now = () => clock;

    it('issues a six-digit PIN that is good for two minutes and one use, with five attempts', () => {
        const pins = new PairingPins({ now, random: () => 0.123456 });
        const pin = pins.issue();
        expect(pin.code).toMatch(/^\d{6}$/);
        expect(pin.expiresAt).toBe(120_000);
        expect(pins.redeem('000000')).toEqual({ ok: false, reason: 'wrong PIN', attemptsLeft: 4 });
        expect(pins.redeem(pin.code)).toEqual({ ok: true });
        expect(pins.redeem(pin.code)).toEqual({ ok: false, reason: 'no PIN is active; issue a new one', attemptsLeft: 0 });
    });

    it('five wrong attempts burn the PIN; an expired PIN is refused', () => {
        const pins = new PairingPins({ now, random: () => 0.5 });
        const pin = pins.issue();
        for (let i = 4; i >= 1; i--) expect(pins.redeem('999999')).toEqual({ ok: false, reason: 'wrong PIN', attemptsLeft: i });
        expect(pins.redeem('999999')).toEqual({ ok: false, reason: 'too many wrong attempts; the PIN was cancelled', attemptsLeft: 0 });
        expect(pins.redeem(pin.code).ok).toBe(false);

        const fresh = pins.issue();
        clock += 120_001;
        expect(pins.redeem(fresh.code)).toEqual({ ok: false, reason: 'the PIN expired; issue a new one', attemptsLeft: 0 });
    });
});

describe('the three-way settings split — derived from the registry', () => {
    const registry: SettingDefinition[] = [
        { key: 'theme', scope: 'device' },
        { key: 'sidebar_width', scope: 'device' },
        { key: 'default_agent', scope: 'workspace' },
        { key: 'provider.claude.path', scope: 'workspace' },
        { key: 'provider.codex.path', scope: 'workspace' },
        { key: 'update_channel', scope: 'host' },
        { key: 'mcp_token', scope: 'host' },
    ];

    it('device → client-local; workspace/agent → host-sourced; host → host-only and hidden from remote clients', () => {
        const split = splitSettings(registry);
        expect(split.clientLocal).toEqual(['theme', 'sidebar_width']);
        expect(split.hostSourced).toEqual(['default_agent', 'provider.claude.path', 'provider.codex.path']);
        expect(split.hostOnly).toEqual(['update_channel', 'mcp_token']);
    });

    it('every key lands in exactly one bucket — a new provider setting is placed by its scope, never by a list', () => {
        const withNew = [...registry, { key: 'provider.kimi.path', scope: 'workspace' as const }];
        const split = splitSettings(withNew);
        const all = [...split.clientLocal, ...split.hostSourced, ...split.hostOnly];
        expect(all).toHaveLength(withNew.length);
        expect(new Set(all).size).toBe(withNew.length);
        expect(split.hostSourced).toContain('provider.kimi.path');
    });
});
