import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mobileServerState, startMobileServer, stopMobileServer } from '../server';
import type { MobileServerDeps } from '../server';
import type { MobileDataDeps } from '../api';
import type { MobileCert } from '../tls';

/**
 * SELF-HEAL an http fallback (the upgrade-over-mobile lockout).
 *
 * When a Tailscale cert can't be minted at bind time — the norm right after an
 * upgrade RELAUNCH, while the tailnet is still reconnecting — the server falls
 * back to http-over-WireGuard. The phone, though, holds an `https://<magic-dns>`
 * URL, so it can no longer reach the host: "not found", stuck until a manual
 * restart. The server must therefore RE-ATTEMPT the cert and rebind to HTTPS the
 * moment the tailnet comes up, on its own.
 *
 * A real Tailscale cert needs a real tailnet, so the cert acquisition is injected
 * (`deps.acquireCert`) and returns a genuine self-signed pair — enough for
 * `https.createServer` to bind, which is all `secure` reflects.
 */

// A long-lived self-signed cert/key (from site-proxy.test.ts) — just enough for
// https.createServer to complete binding; it is never trust-verified here.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDMjCCAhqgAwIBAgIULF/syeRZbfjSyYcMTOPCKYgsnjswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJdHlubi50ZXN0MCAXDTI2MDcwMzIzMjcyNloYDzIxMjYw
NjA5MjMyNzI2WjAUMRIwEAYDVQQDDAl0eW5uLnRlc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDTj+J24kMh9gKWSsioYdC1aWbINuYxtBnBm+Sj8TQq
jxpkEiTCKZUp/JQKQYk2zsB33GWIgFkXILVHtbQZ5jw/ASFs7Tmeza+IZEn0S1S2
ykLQ8QLg4LHHDGavmWBop3YBg0HCIDndgZVrVZCRyjMJ+Pa8da9+7KTGaWdrgC7/
ofrBBqAdjHyx6bOViqUpgwlNEWzr4RFbsQbuXgcXxSljT3UdK0cNEzq1GlE+hLGv
Rdx7QYTReggC5exzRwPnprNA2M5bs0usB4njBzUzW2gq3SOg65BLPlhkCxhtq/Wq
j/DpJLjbR2veSlI/bMrfCs7HKQBfgTWv3g/M+5dmie03AgMBAAGjejB4MB0GA1Ud
DgQWBBT5Ci5yhX4vM9rKLxV9cNxYqgYtzTAfBgNVHSMEGDAWgBT5Ci5yhX4vM9rK
LxV9cNxYqgYtzTAPBgNVHRMBAf8EBTADAQH/MCUGA1UdEQQeMByCCXR5bm4udGVz
dIIJbG9jYWxob3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQBT9xjkclqJ8N2J
HN70gaMPB/3n6+dZoXbR5MVyBJq1QqyARznrQwxT1ysib+u1/opnfLIBkFfBDIVa
nlOLXLTnZ2z1zeSBfSFEAizKx9n7zhH5Y6wN3UhXZCrMhkKsBq0emPVk62zsVhSl
Nk1LFHgs6nkQV3ZrZrpGaC5lsVJrc57/gSMTiQQp+rqPDNQ7TTm443WJvNQh6474
k4vo6G6jdRVUJCDjMuOPYdTPdJjoV9k8V9ANHAq7yY1rmTaplIdeWv9KIf+Yqc6v
QQOzemqDnp9vUXTBUXrGXcohbxwr3x853Vb/bO7GWdTzanVs7ouYUPoKti8iQeTr
xsyQjUWF
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDTj+J24kMh9gKW
SsioYdC1aWbINuYxtBnBm+Sj8TQqjxpkEiTCKZUp/JQKQYk2zsB33GWIgFkXILVH
tbQZ5jw/ASFs7Tmeza+IZEn0S1S2ykLQ8QLg4LHHDGavmWBop3YBg0HCIDndgZVr
VZCRyjMJ+Pa8da9+7KTGaWdrgC7/ofrBBqAdjHyx6bOViqUpgwlNEWzr4RFbsQbu
XgcXxSljT3UdK0cNEzq1GlE+hLGvRdx7QYTReggC5exzRwPnprNA2M5bs0usB4nj
BzUzW2gq3SOg65BLPlhkCxhtq/Wqj/DpJLjbR2veSlI/bMrfCs7HKQBfgTWv3g/M
+5dmie03AgMBAAECggEAY+SV8T1fpmrzCMTR3xOkiOv2MIYfhgt8d9rkh/ZNg+Ti
+KpKefVJbbRJsFgGcn8ICPBjbqLvrghvICdvHSWFf9hIUJbodI+5GKUF+FgTbWWu
S9ro2Yau2oYD/Fjm2TNs+ETiKUevGuRjSXVy2CvJkqVf11eYIE2bdeXyA6PYTTHx
dQs/bQMQhxPJt7cGOMd1LorlVbtF4JPeZGv2jXRElyE8iD0iYndF3M0xjZJgssAl
ZCsr/3yjqzQWvQoopUKRDRwFiUrPBcZzY213OcdhbPWuB4BqOgKOXYXM8HleWuXo
jgjD8OaQGibVXN+zOV/EjleEjg7xvYf3QeELtArfhQKBgQD7i7UJ8NIZGeCeYn6b
4nq0Zv55JC7VoGrDojW88P//u24lwYgzmO7v4F6MuxNMZQO2hLc0OWgol4zbwRkm
pUnARlCPV8xskOkeSwHm9wWa8SHWxT6B7DPDtUQLdNvBa7vK1RrOkkJ+K8IsuIka
l5mR7QOy7PgKVz9Yst8g2zFRmwKBgQDXTuz57li3CozWnGZsDIiXKhnrRkU0Rlf2
g7geMbd3c1todDTBlJDlWeSpYm48wYznq3nQLU+1AW6qip5+a26Yw/8vH+T3VRU8
bVJMzF6C5SHhPSjuqoQ+I7enuNlY1pnHpNUDtNbwh3Ft3PwVoSQcOiXO2vCECBcR
EAHrOnYqlQKBgE2/QJVx+X4IoYRSrQ9BUOuxabXHmTIuAtG0sSdU1csVA1ZoGtDX
1AIQNykIKU7TafJf0sAxfiANt1u0szFepQzorr2fRW/I2kSiqlPYxcK+BNd833UI
rHcw73cbB1EhG0n10/NFAYg9viZUYwv1D2Iq/5mt5HxNuyaPIqflF7lBAoGAOy8/
5wgErPQieM/vO55KYbs5+rmLRm5bubDFiM9DznsQUms3IUtUdSc7uvAKu3q83+X8
CySZd3kYUZrfLIMdmLKvz+VljDOALecjK2c2R6bypDaqrMiEp4wr7NfcLxZ2mTGP
OICaYO3qWTfYt51fDr9RK0Z1vOV4acFLtbyRRO0CgYBlZtyE311eJG53mPEyx8UQ
2CtL452JNRrsNzFqbpJVse1JGrZKJvPXNpWNpUy3apADkVMJQ2kAxnlwHvIQRM/y
IXnfYkdMpSOxAHTGsYRCtvqgRvvrHvozAhyzNseBvPvDILYpC76qiSGqaXi142bz
xGjX3WqZONEmsY83ZYhZwA==
-----END PRIVATE KEY-----
`;

function baseDeps(tmp: string, acquireCert: MobileServerDeps['acquireCert']): MobileServerDeps {
    return {
        serverVersion: 'test',
        userDataDir: tmp,
        appDir: tmp,
        enabled: true,
        configuredPort: () => 0, // ephemeral — the OS assigns a free port
        data: {} as unknown as MobileDataDeps, // bind-only; the data surface is never hit
        confirmPair: async () => true,
        bindIpOverride: '127.0.0.1',
        acquireCert,
    };
}

describe('mobile cert retry — self-heal an http fallback (upgrade-restart lockout)', () => {
    let tmp: string;
    let certFile: string;
    let keyFile: string;

    beforeEach(() => {
        vi.useFakeTimers();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-cert-retry-'));
        certFile = path.join(tmp, 'cert.pem');
        keyFile = path.join(tmp, 'key.pem');
        fs.writeFileSync(certFile, TEST_CERT);
        fs.writeFileSync(keyFile, TEST_KEY);
    });

    afterEach(() => {
        stopMobileServer();
        vi.useRealTimers();
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    });

    it('re-acquires the cert after a startup fallback and rebinds to HTTPS on its own', async () => {
        const cert: MobileCert = {
            certFile,
            keyFile,
            notAfter: null,
            dnsName: 'genie-host.tail1234.ts.net',
        };
        // Tailnet not ready on the first attempt (post-upgrade), then up.
        const acquireCert = vi
            .fn<(dir: string) => Promise<MobileCert | null>>()
            .mockResolvedValueOnce(null)
            .mockResolvedValue(cert);

        await startMobileServer(baseDeps(tmp, acquireCert));

        // First bind fell back to http — the phone's https URL is dead here.
        expect(acquireCert).toHaveBeenCalledTimes(1);
        expect(mobileServerState().secure).toBe(false);

        // The retry timer fires; the cert is available now → rebind as HTTPS.
        await vi.advanceTimersByTimeAsync(15_000);

        const st = mobileServerState();
        expect(st.secure).toBe(true);
        expect(st.url).toMatch(/^https:\/\/genie-host\.tail1234\.ts\.net:\d+\/m\/$/);
        expect(acquireCert.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('stops retrying after a bounded budget — no forever-poll on a cert-less tailnet', async () => {
        const acquireCert = vi
            .fn<(dir: string) => Promise<MobileCert | null>>()
            .mockResolvedValue(null); // HTTPS-certs never become available

        await startMobileServer(baseDeps(tmp, acquireCert));
        expect(mobileServerState().secure).toBe(false);

        // Advance well past any reasonable retry budget.
        for (let i = 0; i < 50; i += 1) await vi.advanceTimersByTimeAsync(15_000);

        expect(mobileServerState().secure).toBe(false);
        // Bounded: the initial attempt plus a capped number of retries, not 50.
        expect(acquireCert.mock.calls.length).toBeLessThan(50);
    });
});
