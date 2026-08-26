import { describe, expect, it } from 'vitest';
import { planCaExport, countCertificates, writeCaBundle } from '../toolchain-ca';

/**
 * WHERE the trust anchors come from.
 *
 * Genie exports THIS MACHINE's root store rather than shipping a `cacert.pem`.
 * Two reasons, and the second is the load-bearing one:
 *
 *   - a shipped bundle goes stale between releases, and nothing rebuilds it;
 *   - a machine behind a TLS-inspecting corporate proxy is issued certificates
 *     by a root that exists ONLY in its own store. A bundled Mozilla list fails
 *     there — for every host — while the OS store succeeds. Shipping a bundle
 *     would trade one total-HTTPS-failure for another, on exactly the machines
 *     least able to debug it.
 */
describe('exporting the machine root store', () => {
    const DEST = 'C:\\genie\\toolchain\\php\\8.4.24\\cacert.pem';

    it('reads the ROOT store, and only reads it', () => {
        const plan = planCaExport('win32', DEST);

        expect(plan).not.toBeNull();
        const script = plan!.args.join(' ');
        expect(script).toContain('Root');
        // Never a write to the STORE. Importing or removing a certificate would
        // be Genie changing the machine's trust, which is not something a dev
        // tool may do — least of all as a side effect of installing PHP.
        expect(script).not.toMatch(/Import-Certificate|Set-Item/);
        // Tightened rather than relaxed when the Windows Update fetch was added:
        // that step deletes its own temp `.sst`, so a blanket ban on
        // `Remove-Item` stopped meaning anything. What must never happen is a
        // cmdlet writing to a `Cert:` path — which is the actual rule, and a
        // stricter one than the string ban it replaces.
        expect(script).not.toMatch(/(Remove-Item|Set-Item|Import-Certificate)[^;]*Cert:/i);
        // …and the only thing it does remove is that temp file.
        const removals = script.match(/Remove-Item[^;)]*/g) ?? [];
        expect(removals).toHaveLength(1);
        expect(removals[0]).toContain('$sst');
        // -NonInteractive so it can never sit waiting on a prompt during install.
        expect(plan!.args).toContain('-NonInteractive');
    });

    /**
     * THE TRUNCATION BUG, pinned.
     *
     * The first cut printed every root to stdout and parsed it in Node.
     * `defaultCommandRunner` keeps only the LAST 8,000 bytes of stdout, so a
     * 130 KB export silently became its own tail: 4 roots out of 80, the first
     * starting mid-base64. Exit 0, a plausible file on disk, tests green.
     *
     * A bundle missing 95% of its anchors is WORSE than no bundle, because the
     * ini then claims trust is configured and the next person stops looking.
     */
    it('has PowerShell write the file, so the bundle never crosses stdout', () => {
        const plan = planCaExport('win32', DEST);
        const script = plan!.args.join(' ');

        expect(script).toContain('WriteAllText');
        expect(script).toContain('cacert.pem');
        expect(plan!.destPath).toBe(DEST);
    });

    it('quotes the destination path for the shell', () => {
        const plan = planCaExport('win32', "C:\\it's here\\cacert.pem");

        // Doubled, PowerShell's own escape for a single-quoted string. A path is
        // never pasted into a shell on the assumption that it is safe.
        expect(plan!.args.join(' ')).toContain("'C:\\it''s here\\cacert.pem'");
    });

    it('has no plan on posix, where openssl already finds the system store', () => {
        // Not an omission: on mac/Linux PHP resolves the system bundle through
        // openssl's compiled-in defaults, which is why this bug is Windows-only.
        // Writing an ini line there would override something already correct.
        expect(planCaExport('darwin', DEST)).toBeNull();
        expect(planCaExport('linux', DEST)).toBeNull();
    });
});

describe('counting what actually landed', () => {
    it('counts PEM blocks', () => {
        const pem =
            '# a\n-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n' +
            '# b\n-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n';

        expect(countCertificates(pem)).toBe(2);
    });

    it('counts nothing in a file with no blocks', () => {
        expect(countCertificates('')).toBe(0);
        expect(countCertificates('roots exported: 80')).toBe(0);
    });
});

describe('the bundle is verified after it is written', () => {
    const DIR = 'C:\\genie\\toolchain\\php\\8.4.24';

    it('accepts a bundle that actually has certificates in it', () => {
        return expect(
            writeCaBundle(DIR, 'win32', {
                run: async () => ({ code: 0 }),
                read: async () => '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n',
                remove: async () => {},
            }),
        ).resolves.toContain('cacert.pem');
    });

    it('REJECTS and deletes a bundle the export left empty', async () => {
        // Exit 0 is not evidence. This is the shape the truncation bug had, and
        // an empty cacert.pem fails with the same errno 60 while looking like a
        // solved problem.
        let removed: string | null = null;
        const got = await writeCaBundle(DIR, 'win32', {
            run: async () => ({ code: 0 }),
            read: async () => '',
            remove: async (p) => {
                removed = p;
            },
        });

        expect(got).toBeNull();
        expect(removed).toContain('cacert.pem');
    });

    it('returns null when the export command fails, and never throws', () => {
        return expect(
            writeCaBundle(DIR, 'win32', {
                run: async () => ({ code: 1 }),
                read: async () => {
                    throw new Error('should not be read');
                },
                remove: async () => {},
            }),
        ).resolves.toBeNull();
    });

    it('returns null when the file cannot be read back at all', () => {
        // An install that FAILS over a missing bundle would be a regression: a
        // PHP without one is exactly today's behaviour.
        return expect(
            writeCaBundle(DIR, 'win32', {
                run: async () => ({ code: 0 }),
                read: async () => {
                    throw new Error('ENOENT');
                },
                remove: async () => {},
            }),
        ).resolves.toBeNull();
    });
});

/**
 * COMPLETENESS: the local root store is not the whole trust list.
 *
 * Found by questioning the export after it had already merged. The Windows root
 * store is LAZILY POPULATED — the OS ships a subset and fetches a missing root
 * on demand through CryptoAPI. Measured on the reporting machine:
 *
 *     Cert:\\LocalMachine\\Root   ->  81 roots
 *     certutil -generateSSTFromWU  -> 554 roots
 *     union, deduped by thumbprint -> 561 roots
 *
 * A static `cacert.pem` cannot fetch anything on demand. Exporting only the
 * local store therefore ships whatever this machine HAPPENS to have cached, and
 * a site whose issuer chains to any of the other ~473 roots fails errno 60 —
 * the exact bug the bundle exists to fix, reintroduced in a form that works on
 * the developer's machine and fails on a fresh one.
 *
 * So: BOTH. Windows Update supplies the complete current list; the local store
 * supplies the private and corporate anchors WU has never heard of (7 of them
 * here). Neither source alone is correct.
 */
describe('the bundle covers roots this machine has not cached yet', () => {
    const DEST = 'C:\\genie\\toolchain\\php\\8.4.24\\cacert.pem';

    it('pulls the full list from Windows Update AND the local store', () => {
        const script = planCaExport('win32', DEST)!.args.join(' ');

        expect(script).toContain('generateSSTFromWU');
        // The local store is not replaced by it: a TLS-inspecting corporate
        // proxy's root exists ONLY there, and dropping it would break every
        // host on exactly the machines least able to diagnose it.
        expect(script).toContain('LocalMachine');
    });

    it('dedupes by thumbprint, since the two sources overlap almost entirely', () => {
        // 554 + 81 with no dedupe is a bundle listing most roots twice. Valid,
        // but it makes "which roots do I trust" unanswerable by reading it.
        expect(planCaExport('win32', DEST)!.args.join(' ')).toContain('Thumbprint');
    });

    it('still writes a bundle when Windows Update cannot be reached', () => {
        // Offline, or WU blocked by policy. The local store alone is what
        // shipped before and is strictly better than no bundle, so the WU fetch
        // is wrapped and the local enumeration is NOT — a failure there means
        // there is genuinely nothing to write.
        const script = planCaExport('win32', DEST)!.args.join(' ');
        const wuAt = script.indexOf('generateSSTFromWU');
        const catchAt = script.indexOf('catch');

        expect(wuAt).toBeGreaterThan(-1);
        expect(catchAt).toBeGreaterThan(wuAt);
        // The local store is enumerated AFTER the guarded WU block, outside it.
        expect(script.indexOf('LocalMachine')).toBeGreaterThan(catchAt);
    });
});
