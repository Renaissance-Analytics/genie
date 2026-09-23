/** VM-only fixture: real host-process spawn, loopback listener, SQLite and inbox. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    createTerminalSpec, deleteTerminalSpec, deleteAppGrant, getDb, getWorkspace,
    removeWorkspace, setAppGrantCapabilities, upsertAppGrant,
} from '../db';
import { agentInboxBroker } from '../agentinbox/broker';
import { agentInboxJoinInputFor } from '../agentinbox/join-input';
import { agentInboxForMcp } from '../mcp/host-tools';
import { createHostProcessRun } from '../dev-server/host-process-run';

// A backend program, not an HTTP call from Electron's main process. Its only
// credentials come from the production host runner's environment injection.
const BACKEND = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
const publish = (name, value) => {
  const file = path.join(dir, name + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(value));
  fs.renameSync(file + '.tmp', file);
};
async function send() {
  if (!process.env.GENIE_APP_URL || !process.env.GENIE_APP_TOKEN) throw new Error('App credentials were not injected');
  const response = await fetch(process.env.GENIE_APP_URL + '/call', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + process.env.GENIE_APP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'agentinbox', args: { action: 'send', to: config.ref, text: config.text } }),
  });
  return { status: response.status, body: await response.json() };
}
(async () => {
  publish('sent', await send());
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(path.join(dir, 'revoked-grant'))) {
    if (Date.now() > deadline) throw new Error('Revocation fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  publish('revoked', await send());
})().catch(error => { publish('failed', { error: error.message }); process.exitCode = 1; });
`;

export async function backendInboxDelivery() {
    if (process.env.GENIE_E2E !== '1') throw new Error('E2E fixture is disabled.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-app-backend-e2e-'));
    const id = randomUUID();
    const appId = `com.genie.inbox-${id}`;
    const terminalId = `recipient-${id}`;
    const runner = createHostProcessRun({ logDir: path.join(dir, 'logs') });
    const siteId = `backend-${id}`;
    const text = `Backend answer ${id}`;
    const readResult = async (name: string) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const failed = path.join(dir, 'failed.json');
            if (fs.existsSync(failed)) throw new Error(fs.readFileSync(failed, 'utf8'));
            const result = path.join(dir, `${name}.json`);
            if (fs.existsSync(result)) return JSON.parse(fs.readFileSync(result, 'utf8'));
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`Backend did not publish ${name}; check the host-runner wiring.`);
    };
    try {
        getDb().prepare("INSERT INTO workspaces (id,backend,project_id,project_name,tynn_project_id,tynn_project_name,shape,path) VALUES (?,'none',?,'Backend Inbox Fixture',?,'Backend Inbox Fixture','simple',?)").run(id, id, id, dir);
        upsertAppGrant({ appId, workspaceId: id, name: 'Backend Inbox Fixture', version: '1',
            slug: siteId, scope: 'self', workspaces: [], capabilities: ['notify'], manifestJson: '{}',
            installPath: dir, source: null, revoked: false, devMode: false });
        // The fixture recipient is a real persisted agent identity and inbox,
        // without invoking a paid model. Receive uses the production MCP handler.
        const spec = createTerminalSpec({ id: terminalId, workspace_id: id, label: 'Backend Recipient', cwd: dir,
            meta: { agent: 'codex', agent_id: `agent-${id}`, whisper_purpose: 'backend-recipient', whisper_scope: 'self', whisper_wake_on_dm: false } });
        const join = agentInboxJoinInputFor(spec, getWorkspace);
        if (!join) throw new Error('Recipient fixture could not resolve its workspace.');
        const recipient = agentInboxBroker.join(join);
        fs.writeFileSync(path.join(dir, 'backend.cjs'), BACKEND);
        fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ ref: recipient.ref, text }));
        const started = await runner.start({ siteId, workspaceId: id,
            command: [process.execPath, path.join(dir, 'backend.cjs'), dir], cwd: dir,
            env: { ELECTRON_RUN_AS_NODE: '1' } });
        if (!started.ok) throw new Error(`Backend spawn failed: ${started.error}`);
        const sent = await readResult('sent');
        const received = await agentInboxForMcp(terminalId, { action: 'receive' });
        setAppGrantCapabilities(appId, []);
        fs.writeFileSync(path.join(dir, 'revoked-grant'), '');
        const revoked = await readResult('revoked');
        const afterRevocation = await agentInboxForMcp(terminalId, { action: 'receive' });
        return { appId, text, sent, received, revoked, afterRevocation };
    } finally {
        try { await runner.stop(siteId); }
        finally {
            agentInboxBroker.leaveByTerminal(terminalId);
            deleteTerminalSpec(terminalId);
            deleteAppGrant(appId);
            removeWorkspace(id);
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    }
}
