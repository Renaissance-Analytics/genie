import { describe, expect, it, vi } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { hostingTools, type ServiceExec } from '../src/main/mcp-tools-hosting.js';
import type { HostingServices } from '../src/main/hosting-actions.js';
import type { Caller } from '../src/main/mcp-tools.js';

// Real handler/caller/confinement logic; only engines and execution are injected. No process is launched.
function rig(allowed = true) {
    const caller: Caller = { agentId: mintAgentId(), agentName: 'fixture', workspaceId: 'work', workspacePath: process.cwd() };
    const inputs: Parameters<ServiceExec>[0][] = [];
    const exec: ServiceExec = async (input) => { inputs.push(input); return { exitCode: 0, output: '', timedOut: false }; };
    const approve = vi.fn(async () => allowed ? 'allowed' as const : 'denied' as const);
    const env = {
        DB_PASSWORD: 'fixture-env-633', DATABASE_URL: 'postgres://fixture:fixture-url-633@127.0.0.1/db',
        REVERB_APP_KEY: 'fixture-public-633', VITE_REVERB_APP_KEY: 'fixture-public-633',
    };
    const services = {
        engines: {
            envFor: () => env,
            list: () => [{ scope: { kind: 'shared' }, credentials: { password: 'fixture-engine-633' }, admin: { password: 'fixture-admin-633' }, slices: { work: { password: 'fixture-own-slice-633' }, other: { password: 'fixture-other-slice-633' } } }],
        },
    } as unknown as HostingServices;
    const tools = hostingTools({ services, exec, approve, resolveCaller: (key) => key === 'owner-session' ? caller : null });
    const handler = tools.find((tool) => tool.definition.name === 'services')!.handler;
    const call = (args: Record<string, string | object> = {}, session = 'owner-session') => handler(
        { action: 'exec', command: 'php artisan test', ...args },
        { server: 'genie', tool: 'services', headers: { 'genie-session': session } },
    );
    return { caller, inputs, call, approve };
}

describe('service command observation uses trusted host context (#633)', () => {
    it('attributes the run to the authenticated owner despite forged argument metadata', async () => {
        const w = rig();
        const result = await w.call({ terminalId: 'forged-terminal', run: { id: 'forged-run', workspaceId: 'other', agentId: 'other', secrets: [] } });
        expect(result.isError).toBe(false);
        expect(w.inputs).toHaveLength(1);
        expect(w.inputs[0]!.run).toMatchObject({ workspaceId: 'work', agentId: w.caller.agentId, name: expect.any(String) });
        expect(w.inputs[0]!.run?.id).toMatch(/^service-command-/);
        expect(w.inputs[0]!.run?.id).not.toBe('forged-run');
    });

    it('supplies the same complete engine/env secret set for live masking as final masking, excluding public keys', async () => {
        const w = rig(); await w.call();
        expect(w.inputs[0]!.run?.secrets).toEqual(expect.arrayContaining([
            'fixture-env-633', 'fixture-url-633', 'fixture-engine-633', 'fixture-admin-633', 'fixture-own-slice-633', 'fixture-other-slice-633',
        ]));
        expect(w.inputs[0]!.run!.secrets).not.toContain('fixture-public-633');
    });

    it('assigns separate IDs to identical commands rather than matching runs by command text', async () => {
        const w = rig(); await w.call(); await w.call();
        const ids = w.inputs.map((input) => input.run?.id);
        expect(ids[0]).toEqual(expect.any(String));
        expect(ids[1]).toEqual(expect.any(String));
        expect(ids[0]).not.toBe(ids[1]);
    });

    it('CONTROL: denied approval never executes or creates run context', async () => {
        const w = rig(false); const result = await w.call();
        expect(result.isError).toBe(true); expect(w.inputs).toEqual([]);
        expect(w.approve).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: an unknown session is refused before approval or execution', async () => {
        const w = rig(); const result = await w.call({}, 'unknown-session');
        expect(result.isError).toBe(true); expect(w.inputs).toEqual([]); expect(w.approve).not.toHaveBeenCalled();
    });

    it('CONTROL: workspace traversal is refused before approval or execution', async () => {
        const w = rig(); const result = await w.call({ cwd: '..' });
        expect(result.isError).toBe(true); expect(w.inputs).toEqual([]); expect(w.approve).not.toHaveBeenCalled();
    });
});
