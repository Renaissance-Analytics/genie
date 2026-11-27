import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE RELEASE KEY EVERY LAUNCHER TRUSTS (Tynn #1058 L8). The owner made the release signing key on 2026-11-27: the secret
 * GENIE_MANIFEST_SIGNING_KEY and the variable GENIE_MANIFEST_PUBLIC_KEY of the `release` environment on
 * Renaissance-Analytics/genie. Its public half is built into the launcher (native/launcher/src/keys.rs RELEASE_PUBLIC_KEY),
 * so a launcher trusts the stable releases whoever built it. The release job's signing step refuses when the environment's
 * public key is not that one: it can never sign with a key the launchers do not trust. Tests sign with throwaway keys made
 * inside the VMs; nothing here reads the secret.
 */
const RELEASE_KEY = 'ydpbhCd7vI9op9SIft6OaN3A8n9aMXjETzBjXRG/49s=';
const keysRs = () => readFileSync('native/launcher/src/keys.rs', 'utf8').replace(/\r\n/g, '\n');

describe('the release public key', () => {
    it('is built into the launcher, exactly', () => {
        expect(keysRs()).toContain(`pub const RELEASE_PUBLIC_KEY: &str = "${RELEASE_KEY}";`);
        expect(Buffer.from(RELEASE_KEY, 'base64')).toHaveLength(32);
    });

    it('is trusted before any key given at build time', () => {
        const fn = keysRs().match(/pub fn trusted_keys[\s\S]*?\n}\n/)?.[0] ?? '';
        expect(fn).toMatch(/let mut texts: Vec<String> = vec!\[RELEASE_PUBLIC_KEY\.to_string\(\)\];/);
    });

    it('the release job signs only with the key the launchers trust: it compares the environment\'s with the built-in one', () => {
        const wf = readFileSync('.github/workflows/release.yml', 'utf8').replace(/\r\n/g, '\n');
        expect(wf).toMatch(/RELEASE_PUBLIC_KEY[^\n]*native\/launcher\/src\/keys\.rs/);
        expect(wf).toMatch(/::error::[^\n]*GENIE_MANIFEST_PUBLIC_KEY is not the key built into the launcher[^\n]*nothing was signed or uploaded/);
    });
});
