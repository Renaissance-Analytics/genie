/** VM-only: actual Prism drivers, native fixture children, real process ownership, no model inference. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { McpServer } from '@particle-academy/prism-acp';
import { agentRecord, mintAgentId, type AgentId } from '../../src/core/identity.js';
import { subtreeOf, systemProcessTree, type ProcessInfo } from '../../src/core/process-tree.js';
import { SessionHost } from '../../src/main/session-host.js';

const dir = await mkdtemp(join(tmpdir(), 'genie-native-preparation-'));
const fixture = fileURLToPath(new URL('./fixtures/prepared-provider.mjs', import.meta.url));
const previous = { claude: process.env.GENIE2_CLAUDE_BINARY, codex: process.env.GENIE2_CODEX_BINARY };
process.env.GENIE2_CLAUDE_BINARY = fixture; process.env.GENIE2_CODEX_BINARY = fixture;
process.env.GENIE_PAIRING_FIXTURE = 'gpk_not_for_children';
const spawned = new Map<AgentId, readonly ProcessInfo[]>();
const waits = new Map<AgentId, { resolve: (servers: readonly McpServer[]) => void; signal: AbortSignal }>();
const host = new SessionHost({ userData: dir,
    prepareMcpServers: (agent, _cwd, signal) => new Promise((resolve) => { waits.set(agent.id, { resolve, signal }); }),
    lifecycle: { spawned: (id, _run, children) => { spawned.set(id, children); }, ended: () => {}, straggler: () => {} },
});
const records = (['claude', 'codex'] as const).map((provider) => agentRecord({ id: mintAgentId(), workspaceId: 'proof', provider, name: `prepared-${provider}` }));
const cancelled = agentRecord({ id: mintAgentId(), workspaceId: 'proof', provider: 'codex', name: 'cancelled-before-launch' });
let neighbor: ReturnType<typeof spawn> | null = null;
const until = async (test: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 10000;
    while (!await test()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await delay(25); }
};
const keyFor = (index: number) => `Bearer rpk_${String(index + 1).repeat(26)}.${'a'.repeat(64)}`;
const server = (index: number): McpServer => ({ type: 'http', name: 'tynn', url: 'https://tynn.ai/mcp/tynn',
    headers: [{ name: 'Authorization', value: keyFor(index) }],
});
try {
    for (const record of [...records, cancelled]) assert.deepEqual(host.start(record, dir), { ok: true });
    await until(() => waits.size === 3, 'all preparations entered');
    assert.deepEqual((await readdir(dir)).filter((p) => /^(claude|codex)\.json$/.test(p)), [], 'no native provider before preparation');
    host.stop(cancelled.id, { graceful: false });
    assert.equal(waits.get(cancelled.id)!.signal.aborted, true);
    waits.get(cancelled.id)!.resolve([server(3)]);
    assert.deepEqual(await host.ended(cancelled.id), { verified: true, ended: 0 });

    neighbor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const neighborPid = neighbor.pid!;
    assert(systemProcessTree.snapshot()?.some((p) => p.pid === neighborPid), 'presence control: neighboring child exists');
    for (const [index, record] of records.entries()) waits.get(record.id)!.resolve([server(index)]);
    await until(async () => (await readdir(dir)).filter((p) => /^(claude|codex)\.json$/.test(p)).length === 2, 'both real adapters reached their native child');
    for (const [index, record] of records.entries()) {
        const capture = JSON.parse(await readFile(join(dir, `${record.provider}.json`), 'utf8'));
        const own = keyFor(index);
        assert.equal(capture.servers.tynn.url, 'https://tynn.ai/mcp/tynn');
        assert.equal((capture.servers.tynn.headers ?? capture.servers.tynn.http_headers).Authorization, own);
        assert.equal(capture.leakedPairing, false, 'main-only pairing fixture never enters child environment');
        assert(!JSON.stringify(capture.argv).includes(own), 'credential is absent from argv');
        assert(!JSON.stringify(host.probe(record.id)).includes(own), 'credential is absent from live view');
        if (record.provider === 'claude') assert.equal(capture.privateMode, 0o600, 'Prism MCP temporary file is private');
        // Prism spawns a supervisor synchronously; that supervisor starts the provider after its IPC handshake.
        // The recorded root must own the actual provider now, even when that descendant did not exist at the snapshot.
        const table = systemProcessTree.snapshot(); assert(table, 'process table is readable');
        assert(subtreeOf(table, spawned.get(record.id) ?? []).some((p) => p.pid === capture.pid), 'actual delayed provider descends from a recorded spawn');
        assert(!spawned.get(record.id)?.some((p) => p.pid === neighborPid), 'neighbor is outside this run');
        assert(systemProcessTree.snapshot()?.some((p) => p.pid === capture.pid), 'presence control: provider exists before Stop');
        host.stop(record.id, { graceful: false });
        const verdict = await host.ended(record.id);
        assert.equal(verdict?.verified, true); assert(verdict && 'ended' in verdict && verdict.ended >= 1);
        assert(!systemProcessTree.snapshot()?.some((p) => p.pid === capture.pid), 'native provider is gone after Stop');
        assert(systemProcessTree.snapshot()?.some((p) => p.pid === neighborPid), 'neighbor survives Stop');
    }
    console.log('PASS actual Claude/Codex adapters: delayed private MCP, distinct keys, no argv/view/pairing leak, cancelled launch, verified Stop preserves neighbor. No model inference.');
} finally {
    host.stopAll(); await host.drained(2000); await host.settled();
    if (neighbor && neighbor.exitCode === null && neighbor.signalCode === null) {
        const ended = new Promise<void>((yes) => neighbor!.once('exit', () => yes())); neighbor.kill(); await ended;
    }
    for (const provider of ['claude', 'codex'] as const) {
        const key = `GENIE2_${provider.toUpperCase()}_BINARY`; const old = previous[provider];
        if (old === undefined) delete process.env[key]; else process.env[key] = old;
    }
    delete process.env.GENIE_PAIRING_FIXTURE;
    await rm(dir, { recursive: true, force: true });
}
