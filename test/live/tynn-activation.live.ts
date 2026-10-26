/** VM-only: production composition through both actual Prism adapters; fixture providers, no model or Tynn traffic. */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { agentRecord, mintAgentId } from '../../src/core/identity.js';
import { composeServices } from '../../src/main/compose.js';
import { SessionHost } from '../../src/main/session-host.js';

if (process.env.GENIE_TEST_VM !== '1') throw new Error('Run this gate in a test VM through the shared FIFO.');
const dir = await mkdtemp(join(tmpdir(), 'genie-native-activation-'));
const linked = join(dir, 'linked'); const unlinked = join(dir, 'unlinked');
await mkdir(linked); await mkdir(unlinked);
await writeFile(join(linked, 'project.json'), JSON.stringify({ tynn: { projectId: 'fixture-project' } }));
await writeFile(join(unlinked, 'project.json'), '{}');
const fixture = fileURLToPath(new URL('./fixtures/prepared-provider.mjs', import.meta.url));
const previous = { claude: process.env.GENIE2_CLAUDE_BINARY, codex: process.env.GENIE2_CODEX_BINARY };
process.env.GENIE2_CLAUDE_BINARY = fixture; process.env.GENIE2_CODEX_BINARY = fixture;
process.env.GENIE_PAIRING_FIXTURE = 'synthetic-main-only';
const records = (['claude', 'codex'] as const).flatMap((provider) => ['linked', 'unlinked'].map((workspaceId) =>
    agentRecord({ id: mintAgentId(), workspaceId, provider, name: `${workspaceId}-${provider}` })));
type Remote = { id: string; name: string; external_id: string; status: string; tokens: Array<{ public_id: string; active: boolean }> };
const remote: Remote[] = []; const auth = new Map<string, string>();
let requests = 0; let release!: () => void;
const lookup = new Promise<void>((yes) => { release = yes; });
// Fixture encryption exercises compose's private vault. Native safeStorage/DPAPI is a separate maintained gate.
const encryptionKey = randomBytes(32);
const composed = await composeServices({ userData: join(dir, 'home'), caddyBin: null, frontDoorPort: 0, v1Settings: () => null,
    pty: { open: () => { throw new Error('No terminal expected'); }, write: () => false, resize: () => false, kill: () => false, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} },
    workspaces: () => [{ id: 'linked', path: linked }, { id: 'unlinked', path: unlinked }],
    tynnCipher: { isAvailable: () => true,
        encrypt: (text) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv); const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
        decrypt: (bytes) => { const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); } },
    tynn: () => ({ status: () => ({ signedIn: true }), userId: () => 'fixture-account', request: async (path, init) => {
        requests++; await lookup;
        const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
        if (init.method === 'GET') return answer({ project_id: 'fixture-project', agents: remote });
        const body = init.body as { name: string; external_id: string; agent_name: string };
        if (path.endsWith('/agents')) { const row = { id: `remote-${remote.length}`, name: body.name, external_id: body.external_id, status: 'active', tokens: [] }; remote.push(row); return answer({ agent: row }); }
        const row = remote.find((r) => r.name === body.agent_name)!;
        const publicId = String(remote.length).padStart(26, '0'); const token = `rpk_${publicId}.${'a'.repeat(64)}`;
        row.tokens.push({ public_id: publicId, active: true }); auth.set(row.external_id, `Bearer ${token}`);
        return answer({ token, agent: { id: row.id }, mcp_url: 'https://tynn.ai/mcp/tynn' });
    } }),
});
const host = new SessionHost({ userData: join(dir, 'sessions'), prepareMcpServers: (record, _cwd, signal) => composed.prepareAgentMcp(record, signal) });
const until = async (check: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 45_000;
    while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(25); }
};
try {
    for (const record of records.filter((r) => r.workspaceId === 'linked')) assert.deepEqual(host.start(record, linked), { ok: true });
    await until(() => requests > 0, 'private identity lookup entered');
    assert.equal((await readdir(linked)).some((name) => name.endsWith('.json') && name !== 'project.json'), false, 'no provider before credential preparation');
    release();
    for (const record of records.filter((r) => r.workspaceId === 'unlinked')) assert.deepEqual(host.start(record, unlinked), { ok: true });
    for (const record of records) {
        const cwd = record.workspaceId === 'linked' ? linked : unlinked;
        const file = join(cwd, `${record.provider}.json`);
        await until(async () => { try { await readFile(file); return true; } catch { return false; } }, 'actual provider capture');
        const capture = JSON.parse(await readFile(file, 'utf8'));
        assert(capture.serverNames.includes('other'), 'unrelated inherited MCP servers remain available');
        if (record.provider === 'claude') assert.equal(capture.permissionHooksPresent, true, 'shell permission hooks remain enabled');
        assert.equal(capture.tynnEnabled, record.workspaceId === 'linked', 'unlinked sessions cannot inherit Tynn');
        if (record.workspaceId === 'linked') {
            const credential = auth.get(record.id)!; assert(credential, 'this local agent was bound to its own remote identity');
            assert.equal(capture.authSha256, createHash('sha256').update(credential).digest('hex'), 'native child received its own credential');
            assert(!JSON.stringify(capture.argv).includes(credential), 'credential absent from argv');
            assert(!JSON.stringify(host.probe(record.id)).includes(credential), 'credential absent from session status');
            if (record.provider === 'codex') { assert.equal(capture.bearerExcluded, true); assert.equal(capture.shellSnapshotDisabled, true); }
        }
        assert.equal(capture.leakedPairing, false);
        host.stop(record.id, { graceful: false }); assert.equal((await host.ended(record.id))?.verified, true);
    }
    assert.equal(auth.size, 2); assert.equal(new Set(auth.values()).size, 2);
    assert(!(await readFile(join(dir, 'home/agent-credentials/agents.json'), 'utf8')).includes('rpk_'));
    console.log('PASS production composition through actual Claude/Codex adapters: distinct private identities, delayed launch, unlinked inheritance denied, no argv/status/pairing leak, shell isolation and verified Stop. Synthetic API and encryption ports; no inference.');
} finally {
    release(); host.stopAll(); await host.drained(2000); await host.settled(); await composed.shutdown();
    for (const provider of ['claude', 'codex'] as const) {
        const key = `GENIE2_${provider.toUpperCase()}_BINARY`; const value = previous[provider];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete process.env.GENIE_PAIRING_FIXTURE;
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('genie-native-activation-')) throw new Error('Refusing fixture cleanup outside its temporary root');
    await rm(dir, { recursive: true, force: true });
}
