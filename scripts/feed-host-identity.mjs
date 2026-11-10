#!/usr/bin/env node
/**
 * THE HOST'S IDENTITY IN THE RELEASE FEED (Tynn #413, host split P6). Appends two ADDITIVE keys to an updater feed
 * (latest.yml, latest-linux.yml), after electron-builder wrote it and before it is uploaded:
 *
 *   genieHostHash: the host bundle's hash, as its build names it (engine-launch.ts `hostBuild`: 12 hex of SHA-256)
 *   genieEngineProtocol: the engine protocol it speaks (core/engine-protocol.ts `ENGINE_PROTOCOL`)
 *
 * Nothing else in the file changes: electron-updater ignores keys it does not know, and its SHA-512s cover the installer,
 * not this file. The running Genie compares them with its own host (core/update-kind.ts); missing or unknown is a full update.
 *
 *   node scripts/feed-host-identity.mjs <feed.yml> [dist/main/host.js] [src/core/engine-protocol.ts]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function feedHostIdentity(yml, host) {
    if (/^genieHostHash:/m.test(yml) || /^genieEngineProtocol:/m.test(yml)) throw new Error('the feed already names a host');
    if (!Number.isInteger(host.protocol) || host.protocol < 1) throw new Error(`not an engine protocol: ${host.protocol}`);
    const hash = createHash('sha256').update(readFileSync(host.hostScript)).digest('hex').slice(0, 12);
    const end = yml.endsWith('\n') ? '' : '\n';
    return `${yml}${end}genieHostHash: '${hash}'\ngenieEngineProtocol: ${host.protocol}\n`;
}

/** ENGINE_PROTOCOL as the source says it: the one line `export const ENGINE_PROTOCOL = <n>;`. */
export function engineProtocolIn(source) {
    const m = /^export const ENGINE_PROTOCOL = (\d+);/m.exec(source);
    if (!m) throw new Error('ENGINE_PROTOCOL is not in the engine protocol source');
    return Number(m[1]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const [feed, hostScript = 'dist/main/host.js', protocolSource = 'src/core/engine-protocol.ts'] = process.argv.slice(2);
    if (!feed) { console.error('usage: feed-host-identity.mjs <feed.yml> [host.js] [engine-protocol.ts]'); process.exit(2); }
    const protocol = engineProtocolIn(readFileSync(protocolSource, 'utf8'));
    writeFileSync(feed, feedHostIdentity(readFileSync(feed, 'utf8'), { hostScript, protocol }));
    console.log(`${feed}: genie-host ${createHash('sha256').update(readFileSync(hostScript)).digest('hex').slice(0, 12)}, engine protocol ${protocol}`);
}
