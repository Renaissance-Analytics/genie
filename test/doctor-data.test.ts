import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { osaInstructions } from '../src/core/osa-home.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { doctorDataTools } from '../src/main/doctor-data.js';
import { sessionsDir } from '../src/main/paths.js';
import { OS_WORKSPACE } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * DOCTOR MODE LOADS ONE WORKSPACE AND AGENT, ON DEMAND (the owner, 2026-10-13: "the genie agent is supposed to be able
 * to [access] all user data on a need to access basis. meaning it's not loaded by default but the genie agent can load a
 * single workspace and agent and diagnose any issues it's having"). Doctor still boots bare; its genie gets these tools
 * and opens Genie's data only when one of them asks. They READ: Genie may be running beside doctor, and two writers on
 * one file is how data is lost — so a whole session of calls must leave every byte under ~/.genie as it was.
 */
let home: string;
let ws: string;
const kai = agentRecord({ id: mintAgentId(), workspaceId: 'ws_tynn', provider: 'claude', name: 'kai', instructions: '.agents/kai/AGENT.md' });
const osa = agentRecord({ id: mintAgentId(), workspaceId: OS_WORKSPACE, provider: 'claude', name: 'genie' });

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-doctordata-'));
    ws = join(home, 'projects', 'tynn-folder');
    await mkdir(join(ws, '.agents', 'kai'), { recursive: true });
    await mkdir(join(ws, '.agents', '_genie'), { recursive: true });
    await writeFile(join(ws, 'project.json'), JSON.stringify({ name: 'tynn.ai' }));
    await writeFile(join(ws, '.agents', 'kai', 'AGENT.md'), '# kai\nReviews the Laravel app.\n');
    await writeFile(join(ws, '.agents', '_genie', 'shared.md'), '## Genie 2\n');
    await writeFile(join(ws, 'AGENTS.md'), '# rules\n');
    await writeFile(join(ws, 'CLAUDE.md'), '# rules, edited by hand\n');
    const store = new Store(home);
    await store.writeWorkspaces([{ id: 'ws_tynn', path: ws }, { id: 'ws_gone', path: join(home, 'projects', 'missing') }]);
    await store.writeAgents([kai, osa]);
    await openAgentThread(openDurableStore(sessionsDir(home)), kai.id).record([
        { kind: 'message', speaker: 'you', peerName: null, text: 'use your lists tool' },
        { kind: 'message', speaker: 'agent', peerName: null, text: 'terminal genie is not one Genie knows' },
    ]);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function call(name: string, args: Record<string, unknown> = {}) {
    const tool = doctorDataTools({ genieHome: home }).find((t) => t.definition.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const r = await tool.handler(args as never, { server: 'genie', tool: name, headers: {} });
    return { isError: r.isError, json: JSON.parse(r.text) as Record<string, any> };
}

/** Every file under a folder, with its bytes and modification time. */
async function fingerprint(dir: string): Promise<string> {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else out.push(`${p} ${(await stat(p)).mtimeMs} ${(await readFile(p)).toString('base64')}`);
        }
    };
    await walk(dir);
    return out.sort().join('\n');
}

describe('doctor data', () => {
    it('nothing is opened until a tool asks: building the tools on a home that does not exist creates nothing (the control: a call reads it)', async () => {
        const absent = join(home, 'no-genie-here');
        const tools = doctorDataTools({ genieHome: absent });
        expect(tools.map((t) => t.definition.name)).toEqual(['workspaces', 'loadWorkspace', 'loadAgent']);
        expect(await stat(absent).then(() => true, () => false)).toBe(false);
        const r = await tools[0]!.handler({} as never, { server: 'genie', tool: 'workspaces', headers: {} });
        expect(JSON.parse(r.text)).toMatchObject({ ok: true, workspaces: [] });
    });

    it('workspaces: every workspace by its NAME, with its agents; the workstation agent apart; a folder that is gone says so', async () => {
        const r = await call('workspaces');
        expect(r.isError).toBe(false);
        const tynn = r.json.workspaces.find((w: { id: string }) => w.id === 'ws_tynn');
        expect(tynn).toMatchObject({ name: 'tynn.ai', path: ws, exists: true, agents: [{ name: 'kai', provider: 'claude' }] });
        expect(r.json.workspaces.find((w: { id: string }) => w.id === 'ws_gone')).toMatchObject({ exists: false, agents: [] });
        expect(r.json.workstation.agents).toEqual([{ name: 'genie', provider: 'claude' }]);
    });

    it('loadWorkspace by name: its agents and its agent files — present, missing, and an AGENTS.md / CLAUDE.md mirror that differs', async () => {
        const r = await call('loadWorkspace', { workspace: 'tynn.ai' });
        expect(r.isError).toBe(false);
        expect(r.json.workspace).toMatchObject({ id: 'ws_tynn', name: 'tynn.ai', path: ws });
        expect(r.json.agents.map((a: { name: string }) => a.name)).toEqual(['kai']);
        expect(r.json.agentFiles).toMatchObject({ '.agents/_genie/shared.md': true, '.agents/_genie/genie-claude.md': false, 'AGENTS.md': true, 'CLAUDE.md': true });
        expect(r.json.agentFiles.mirror).toBe('differs');
    });

    it('loadAgent: the record, the persona, and the recorded thread — the words the agent saw', async () => {
        const r = await call('loadAgent', { workspace: 'tynn.ai', agent: 'kai' });
        expect(r.isError).toBe(false);
        expect(r.json.agent).toMatchObject({ id: kai.id, name: 'kai', provider: 'claude', threadId: null });
        expect(r.json.persona).toMatchObject({ path: '.agents/kai/AGENT.md' });
        expect(r.json.persona.text).toContain('Reviews the Laravel app.');
        expect(r.json.history.rows.map((h: { text: string }) => h.text)).toEqual(['use your lists tool', 'terminal genie is not one Genie knows']);
    });

    it('loadAgent with no workspace is the workstation agent, genie', async () => {
        const r = await call('loadAgent', { agent: 'genie' });
        expect(r.json.agent).toMatchObject({ id: osa.id, name: 'genie' });
        expect(r.json.history.rows).toEqual([]);
    });

    it('an unknown name is refused with the names that DO exist — never a guess', async () => {
        const w = await call('loadWorkspace', { workspace: 'tynn' });
        expect(w.isError).toBe(true);
        expect(w.json.error).toContain('tynn.ai');
        const a = await call('loadAgent', { workspace: 'tynn.ai', agent: 'atlas' });
        expect(a.isError).toBe(true);
        expect(a.json.error).toContain('kai');
    });

    it('doctor genie is told the three tools by name, and that they change nothing', () => {
        const doctor = osaInstructions('doctor', { version: '2', platform: 'win32', installDir: 'I', genieHome: 'H', userData: 'U' });
        for (const name of ['workspaces', 'loadWorkspace', 'loadAgent']) expect(doctor).toContain(`\`${name}\``);
        expect(doctor).toMatch(/change nothing/);
    });

    it('reads only: every call leaves every byte under ~/.genie as it was (the control: the fingerprint sees a one-byte write)', async () => {
        const before = await fingerprint(home);
        for (const [name, args] of [['workspaces', {}], ['loadWorkspace', { workspace: 'tynn.ai' }], ['loadAgent', { workspace: 'tynn.ai', agent: 'kai' }], ['loadAgent', { agent: 'genie' }]] as const) await call(name, args);
        expect(await fingerprint(home)).toBe(before);
        await writeFile(join(ws, 'AGENTS.md'), '# rules!\n');
        expect(await fingerprint(home)).not.toBe(before);
    });
});
