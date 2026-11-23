import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_METHODS, isEngineMethod } from '../src/core/engine-protocol.js';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-3c (Tynn #961; part of #913). After 2g-3b (#959) the accounts, the keyring card and the
 * registration are genie-host's, and main reaches them only over the one protocol. What the engine link kept for them is
 * dead: the window's replicas of the Tynn and GitHub accounts, the keyring and the relay registration, the agent-secret
 * routes, and main's `prepareMcpServers` (genie-host prepares an agent's MCP servers itself: session-engine-server.ts
 * hostOptions). With them go compose's `tynn`/`tynnSecrets` inputs (main passed neither), and the plugin and catalog
 * replicas main handed compose only to read nothing from them (the feature machine that reads them runs in genie-host).
 * Each goes end to end: client, server, engine method and the pins that name it.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

const GONE_METHODS = ['engine.tynn', 'engine.github', 'engine.keyring', 'engine.relayHost', 'engine.secretProbe', 'engine.secretRead', 'engine.secretStore', 'engine.plugins', 'catalog.snapshot', 'catalog.docs'];
const GONE_EVENTS = ['tynn.event', 'github.event', 'github.open', 'keyring.event', 'relayHost.event', 'plugins.event', 'catalog.snapshot', 'catalog.changed'];

describe('the engine link carries no account, keyring, registration, secret, plugin or catalog route any more', () => {
    it('none of their methods is an engine method: a frame naming one does not parse', () => {
        for (const method of GONE_METHODS) {
            expect(ENGINE_METHODS as readonly string[], method).not.toContain(method);
            expect(isEngineMethod(method), method).toBe(false);
        }
        // CONTROL: the parser still knows a method that stays.
        expect(isEngineMethod('engine.proxyRemember')).toBe(true);
    });

    it('the server answers none of them and says none of their events; the client keeps no replica of them', () => {
        const server = code(src('src/main/session-engine-server.ts'));
        const client = code(src('src/main/session-engine-client.ts'));
        for (const name of [...GONE_METHODS, ...GONE_EVENTS]) {
            expect(server.includes(`'${name}'`), `server: ${name}`).toBe(false);
            expect(client.includes(`'${name}'`), `client: ${name}`).toBe(false);
        }
        for (const replica of ['tynn', 'github', 'keyring', 'relayHost', 'plugins', 'catalog', 'catalogDocs']) {
            expect(client, replica).not.toMatch(new RegExp(`^\\s{4}(async\\s+)?${replica}\\(`, 'm'));
        }
        expect(client).not.toMatch(/prepareMcpServers/);
        // CONTROL: a replica that stays is found by the same pattern.
        expect(client).toMatch(/^\s{4}stores\(/m);
    });

    it('their window-side files are gone: the replicas and linkedAgentSecrets (its file held nothing else)', () => {
        for (const file of ['src/main/tynn-account-replica.ts', 'src/main/github-account-replica.ts', 'src/main/keyring-replica.ts', 'src/main/relay-host-replica.ts', 'src/main/agent-secrets.ts']) {
            expect(existsSync(resolve(root, file)), file).toBe(false);
        }
        // CONTROL: the check finds a file that is there.
        expect(existsSync(resolve(root, 'src/main/plugins-replica.ts'))).toBe(true);
    });

    it('main prepares no agent’s MCP servers and hands compose no plugin or catalog replica; compose takes no Tynn account or secrets', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).not.toMatch(/prepareMcpServers|prepareAgentMcp|tynnNote/);
        expect(main).not.toMatch(/client\??\.(plugins|catalog)\(/);
        expect(main).not.toMatch(/editorBytesDeps|panelsHost|composedNow|composedServices/);
        const compose = code(src('src/main/compose.ts'));
        expect(compose).not.toMatch(/agentTynnPrep|tynnSecrets|prepareAgentMcp|tynnNote|tynnRecovery/);
        expect(compose).not.toMatch(/readonly tynn\?/);
        expect(compose).not.toMatch(/readonly (plugins|catalog)\?:/);
        // CONTROL: genie-host still prepares them (host-agent-keys.ts), and still serves its plugins and catalog.
        expect(code(src('src/main/host-agent-keys.ts'))).toMatch(/agentTynnPrep\(/);
        expect(code(src('src/main/session-engine-server.ts'))).toMatch(/prepareMcpServers: async \(record, cwd, signal\)/);
    });

    it('the window’s engine inventory has no catalog or plugins row: what is left on move:2g is 2g-4’s and G-1’s', () => {
        const rows = WINDOW_ENGINE_INVENTORY.filter(([, d]) => d === 'move:2g').map(([u]) => u).sort();
        // remoteAccess left in 2g-4a (#997).
        // 2g-4e (#1007): the scanner follows main's aliases of the engine client, and the uses it found joined the list
        // (tasks on #955 and G-1 #934); the rows are exactly these.
        expect(rows).toEqual(['filesUnwatch', 'filesWatch', 'flows', 'hosting', 'issueWatch', 'onFilesEvent', 'onSpawnFrame', 'onTynnBoardEvent', 'onTynnFeaturesEvent', 'onTynnIssuesEvent', 'runHostTool', 'spawnLink', 'stores', 'supervisor', 'tynnBoardUnwatch', 'tynnBoardWatch', 'tynnFeaturesUnwatch', 'tynnFeaturesWatch', 'tynnIssuesUnwatch', 'tynnIssuesWatch']);
        expect(rows).not.toContain('catalog');
        expect(rows).not.toContain('plugins');
    });
});
