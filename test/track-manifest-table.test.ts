import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyManifest, verifyTree, type ManifestExpect, type TrackManifest } from '../src/core/track-manifest.js';

/*
 * THE SHARED VERIFY-BEFORE-RUN TABLE (Tynn #1058 L2). test/fixtures/track-manifest-cases.json holds manifest cases (the
 * bytes, the signature file, the trusted keys and what is asked for) and tree cases (what a manifest lists and what a
 * build folder holds), each with the verdict code. This file holds verifyManifest and verifyTree to it; the Rust
 * launcher's native/launcher/tests/manifest_table.rs holds its `check` and `verify_tree` to the same file, so the two
 * readers of one signed format cannot drift. The seeds in the table are published throwaway test keys; Ed25519 is
 * deterministic, so both languages sign each case to the same bytes.
 */

type Edit = [string, string];
type Verdict = { ok: true } | { ok: false; code: string; path?: string };
interface ManifestCase {
    name: string;
    manifest?: string;
    edit?: Edit[];
    tamper?: Edit[];
    signer?: 'a' | 'b';
    sig?: string;
    sigPrefix?: string;
    sigSuffix?: string;
    sigMode?: 'noncanonical';
    keys?: Array<'a' | 'b'>;
    expect?: Partial<ManifestExpect>;
    verdict: Verdict;
}
interface TreeCase { name: string; listed: Array<[string, string]>; tree: Array<[string, string]>; dirs?: string[]; verdict: Verdict }
interface Table {
    format: number;
    seeds: { a: string; b: string };
    base: string;
    expectDefault: ManifestExpect;
    manifestCases: ManifestCase[];
    treeCases: TreeCase[];
}

const table = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'track-manifest-cases.json'), 'utf8')) as Table;

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
function privateFromSeed(seedHex: string): KeyObject {
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
}
const keys = {
    a: privateFromSeed(table.seeds.a),
    b: privateFromSeed(table.seeds.b),
};
const publicB64 = (k: KeyObject) => createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

function applied(text: string, edits: Edit[] | undefined): string {
    let out = text;
    for (const [from, to] of edits ?? []) {
        if (!out.includes(from)) throw new Error(`the edit's text is not there: ${from.slice(0, 40)}`);
        out = out.replace(from, () => to);
    }
    return out;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** The last data character of a padded 64-byte signature carries 2 bits and 4 zero bits: set the lowest. */
function nonCanonical(sig: string): string {
    const at = sig.length - 3;
    const v = ALPHABET.indexOf(sig[at]!);
    return sig.slice(0, at) + ALPHABET[v | 1] + sig.slice(at + 1);
}

/** The delivered bytes, the signature file and the trusted keys of a case. */
function materialise(c: ManifestCase): { bytes: Buffer; sig: string; trusted: string[]; expect: ManifestExpect } {
    const signedText = applied(c.manifest ?? table.base, c.edit);
    const delivered = Buffer.from(applied(signedText, c.tamper), 'utf8');
    const signature = sign(null, Buffer.from(signedText, 'utf8'), keys[c.signer ?? 'a']).toString('base64');
    const sig = c.sig ?? `${c.sigPrefix ?? ''}${c.sigMode === 'noncanonical' ? nonCanonical(signature) : signature}${c.sigSuffix ?? ''}`;
    return { bytes: delivered, sig, trusted: (c.keys ?? ['a']).map((k) => publicB64(keys[k])), expect: { ...table.expectDefault, ...c.expect } };
}

describe('the shared verify-before-run table', () => {
    it('is format 2, names every case once, and has every verdict', () => {
        expect(table.format).toBe(2);
        expect(new Set(table.manifestCases.map((c) => c.name)).size).toBe(table.manifestCases.length);
        expect(new Set(table.treeCases.map((c) => c.name)).size).toBe(table.treeCases.length);
        const codes = new Set(table.manifestCases.map((c) => (c.verdict.ok ? 'ok' : c.verdict.code)));
        expect([...codes].sort()).toEqual(['arch', 'channel', 'downgrade', 'format', 'launcher-too-old', 'ok', 'platform', 'signature', 'track']);
        const treeCodes = new Set(table.treeCases.map((c) => (c.verdict.ok ? 'ok' : c.verdict.code)));
        expect([...treeCodes].sort()).toEqual(['missing-file', 'ok', 'sha256', 'size', 'unlisted-file']);
    });

    it('signs from its seeds what a seed signs (a positive control for every case below)', () => {
        const { bytes, sig, trusted, expect: e } = materialise(table.manifestCases[0]!);
        expect(verifyManifest(bytes, sig, trusted, e)).toMatchObject({ ok: true, key: publicB64(keys.a) });
        expect(publicB64(keys.a)).not.toBe(publicB64(keys.b));
    });

    it.each(table.manifestCases)('verifyManifest: $name', (c) => {
        const { bytes, sig, trusted, expect: e } = materialise(c);
        const v = verifyManifest(bytes, sig, trusted, e);
        expect(v.ok ? { ok: true } : { ok: false, code: v.code }).toEqual(c.verdict);
    });

    describe('verifyTree', () => {
        let dir: string;
        beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1058-table-')); });
        afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

        it.each(table.treeCases)('$name', async (c) => {
            for (const [path, text] of c.tree) {
                await mkdir(dirname(join(dir, path)), { recursive: true });
                await writeFile(join(dir, path), text);
            }
            for (const d of c.dirs ?? []) await mkdir(join(dir, d), { recursive: true });
            const files = [...c.listed]
                .sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])))
                .map(([path, text]) => ({ path, size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }));
            const manifest: TrackManifest = {
                format: 2, track: 'host', build: '2026.11.25-1', schema: '2026.11.25', channel: 'stable', platform: 'linux', arch: 'x64',
                withClient: '2026.11.25-1', minLauncher: null, files, notes: '',
            };
            const v = await verifyTree(manifest, dir);
            expect(v.ok ? { ok: true } : { ok: false, code: v.code, path: v.path }).toEqual(c.verdict);
        });
    });
});
