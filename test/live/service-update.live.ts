/** Run ONLY inside the test VM. Product registry/driver against real Docker; no owner's services are used. */
import { strict as assert } from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerNameOf, dataVolumeOf } from '../../src/core/services.js';
import { execFileRunner } from '../../src/main/toolchain-runner.js';
import { dockerRunnerOver, ServiceDriver } from '../../src/main/service-driver.js';
import { ServiceRegistry } from '../../src/main/service-registry.js';

assert.equal(process.env.GENIE_SERVICE_UPDATE_VM_PROOF, '1', 'this proof requires the isolated test VM');
assert.equal(process.platform, 'linux', 'run this proof in omarchy-test');
const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const p = (server.address() as { port: number }).port; server.close((error) => error ? reject(error) : resolve(p)); });
});
const scope = { kind: 'dedicated' as const, workspaceId: `update-proof-${randomUUID().slice(0, 8)}` };
const dir = await mkdtemp(join(tmpdir(), 'genie-service-update-proof-'));
const calls: string[][] = [];
const docker = dockerRunnerOver((binary, args, options) => execFileRunner('sudo', ['-n', binary, ...args], options));
const driver = new ServiceDriver((args) => { calls.push([...args]); return docker(args); });
const registry = await ServiceRegistry.open(dir, driver, { allocatePort: () => port, randomPassword: () => randomBytes(18).toString('base64url') });
let id: string | null = null;
try {
    const available = await driver.available();
    assert.equal(available.ok, true, 'Docker daemon must be available in the VM');
    const added = await registry.add({ engine: 'redis', major: '7', scope, consent: true });
    assert.notEqual(added.kind, 'needs-consent');
    if (added.kind === 'needs-consent') throw new Error('consent was supplied');
    id = added.instance.id;
    const instance = structuredClone(added.instance);
    const name = containerNameOf(instance);
    const redis = async (argv: string[], authenticated = true) => {
        const result = await driver.exec(name, ['redis-cli', ...(authenticated ? ['-a', instance.credentials.password!, '--no-auth-warning'] : []), ...argv]);
        return result.stdout.trim();
    };
    // Wait for the real engine to answer; never replace readiness with a fixed delay.
    let deadline = Date.now() + 30_000;
    while (await redis(['PING']) !== 'PONG') { assert.ok(Date.now() < deadline, 'Redis did not become ready'); await new Promise((r) => setTimeout(r, 100)); }
    assert.match(await redis(['PING'], false), /NOAUTH/);
    assert.equal(await redis(['SET', 'genie-update-proof', 'kept-value']), 'OK');
    assert.equal(await redis(['SAVE']), 'OK');
    const inspect = async () => {
        const r = await docker(['container', 'inspect', name]); assert.equal(r.exitCode, 0);
        return JSON.parse(r.stdout)[0] as { Id: string; Config: { Env: string[] }; Mounts: { Name: string }[]; HostConfig: { PortBindings: unknown } };
    };
    const before = await inspect();
    const mark = calls.length;
    const preview = await registry.update(id, { consent: false });
    assert.equal(preview.kind, 'needs-consent');
    assert.equal(calls.slice(mark).filter((a) => a[0] === 'pull').length, 0);
    if (process.env.GENIE_SERVICE_UPDATE_BREAK_PROBE !== '1') await registry.update(id, { consent: true });
    const after = await inspect();
    assert.notEqual(after.Id, before.Id, 'the container must actually be recreated');
    assert.deepEqual(after.Mounts.map((m) => m.Name), before.Mounts.map((m) => m.Name));
    assert.ok(after.Mounts.some((m) => m.Name === dataVolumeOf(instance)));
    assert.deepEqual(after.HostConfig.PortBindings, before.HostConfig.PortBindings);
    assert.ok(JSON.stringify(after.Config.Env) === JSON.stringify(before.Config.Env), 'environment preserved');
    assert.ok(JSON.stringify(registry.list().find((i) => i.id === id)) === JSON.stringify(instance), 'registry identity preserved');
    deadline = Date.now() + 30_000;
    while (await redis(['PING']) !== 'PONG') { assert.ok(Date.now() < deadline, 'updated Redis did not become ready'); await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(await redis(['GET', 'genie-update-proof']), 'kept-value');
    assert.match(await redis(['PING'], false), /NOAUTH/);
    assert.equal(calls.slice(mark).filter((a) => a[0] === 'pull').length, 1);
    await registry.stop(id);
    await registry.update(id, { consent: true });
    assert.equal((await registry.status(id)).state, 'exited');
    console.log('PASS: actual container recreated; data, volume, port, env and registry retained; authentication still required; fresh pull counted; stopped engine stayed stopped.');
} finally {
    if (id) await registry.remove(id, { deleteData: true, workspaceId: scope.workspaceId });
    await rm(dir, { recursive: true, force: true });
}
