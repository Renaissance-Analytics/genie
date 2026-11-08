#!/usr/bin/env node
/**
 * EVERY ALERT SOUND IS IN THE BUILT RENDERER (Tynn #441).
 *
 *   node scripts/sound-assets-check.mjs <dist/renderer> <src/renderer/sounds>
 *
 * Reads both folders; runs nothing. Exits 1, naming each one, if a sound file in the sources was not emitted by the
 * build. The player asks for `./sounds/<file>` (src/renderer/alert-sound.ts), which the bundler emits as
 * `assets/<name>-<hash>.<ext>`; electron-builder then packs dist/** whole. test/alert-sound-library.test.ts holds every
 * sound choice to a file in the sources, so this closes the chain: choice, source file, built asset, package.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const SOUND_EXT = /\.(wav|ogg|mp3|flac|m4a|aac|opus)$/i;

/** Each of `sources` (file names) with no emitted asset in `built` (paths under dist/renderer, `/`-separated). */
export function missingSoundAssets(sources, built) {
    const names = built.map((p) => p.split('/').pop() ?? p);
    return sources.filter((file) => {
        const dot = file.lastIndexOf('.');
        const stem = file.slice(0, dot);
        const ext = file.slice(dot);
        // The bundler's hash is 8 URL-safe characters after the name: a longer name sharing the prefix is not this file.
        return !names.some((n) => n.startsWith(`${stem}-`) && n.endsWith(ext) && /^[A-Za-z0-9_-]{8}$/.test(n.slice(stem.length + 1, n.length - ext.length)));
    });
}

function walk(dir) {
    const out = [];
    for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else out.push(p);
    }
    return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/[/\\]+/g, '/').split('/').pop());
if (isMain) {
    const [dist, sounds] = process.argv.slice(2);
    if (!dist || !sounds) {
        console.error('usage: node scripts/sound-assets-check.mjs <dist/renderer> <src/renderer/sounds>');
        process.exit(2);
    }
    const sources = readdirSync(sounds).filter((f) => SOUND_EXT.test(f)).sort();
    const built = walk(dist).map((p) => relative(dist, p).split(/[/\\]/).join('/'));
    const missing = missingSoundAssets(sources, built);
    console.log(`### sound-assets-check: ${sources.length} sound files; ${missing.length} not in the build`);
    for (const file of missing) console.log(`### MISSING   ${file}`);
    // No sources at all is a wrong path, not a pass.
    if (missing.length || sources.length === 0) process.exit(1);
}
