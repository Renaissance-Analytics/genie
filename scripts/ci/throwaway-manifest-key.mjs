#!/usr/bin/env node
/**
 * A THROWAWAY MANIFEST KEY FOR ONE TEST RUN (Tynn #1058 L3), made in the test VM and never kept: the VM is deleted with it.
 * The rows package-tracks and launcher-install sign this run's manifests with it, and build the launcher trusting it
 * (GENIE_MANIFEST_PUBLIC_KEYS at build time), so they prove the real release path without the real key. The release key
 * is the owner's, set up once in the protected release environment (the PR that added this says how); no agent makes,
 * holds or reads it.
 *
 *   node scripts/ci/throwaway-manifest-key.mjs <dir>
 *     writes <dir>/THROWAWAY-manifest-signing-key.pem (0600) and <dir>/THROWAWAY-manifest-public-key.txt; prints the public key
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: throwaway-manifest-key.mjs <dir>'); process.exit(2); }
if (process.env.GITHUB_ACTIONS || process.env.GENIE_RELEASE_JOB) { console.error('throwaway-manifest-key: not in a release job'); process.exit(2); }
mkdirSync(dir, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
writeFileSync(join(dir, 'THROWAWAY-manifest-signing-key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
writeFileSync(join(dir, 'THROWAWAY-manifest-public-key.txt'), pub);
console.log(pub);
