/**
 * genie#1497 — THE REAL TAILSCALE INSTALLER, THROUGH WINDOWS' OWN CHECK. In the Windows test VM only, from the shipped tree after `npm ci`:
 *
 *     npx tsx test/live/tailscale-signature.live.ts
 *
 * It downloads the installer and reads Windows' verdict on it, nothing is run. The publisher in src/main/tailscale-cli.ts was read from the file's certificate table; this is where Windows itself agrees. Then one byte is
 * flipped: the same check must refuse that copy. Exit 0 only when the real file is accepted and the changed one refused.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAuthenticode, refusalOf } from '../../src/main/tailscale-cli.js';

const dir = mkdtempSync(join(tmpdir(), 'tailscale-signature-'));
let code = 1;
try {
    const response = await fetch('https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const file = join(dir, 'tailscale-setup.exe');
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(file, bytes);
    const real = await readAuthenticode(file);
    console.log(`### tailscale-signature real: ${JSON.stringify(real)}  refusal: ${refusalOf(real)}`);

    const changed = join(dir, 'changed.exe');
    const flipped = Buffer.from(readFileSync(file));
    flipped[Math.floor(flipped.length / 3)]! ^= 0xff;
    writeFileSync(changed, flipped);
    const tampered = await readAuthenticode(changed);
    console.log(`### tailscale-signature changed: ${JSON.stringify(tampered)}  refusal: ${refusalOf(tampered)}`);

    code = refusalOf(real) === null && refusalOf(tampered) !== null ? 0 : 1;
} catch (error) {
    console.log(`### tailscale-signature threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
console.log(`### tailscale-signature=${code === 0 ? 'PASS' : 'FAIL'}`);
process.exit(code);
