import { describe, expect, it } from 'vitest';
import { agentConfigsOf, agentConfigWrite, frontmatterMove } from '../src/core/agent-config.js';
import { agentFileText } from '../src/core/agent-create.js';
import { SCHEMA_REVISION } from '../src/core/workspace-model.js';
import { adoptAgent, readImportedAgents, type AgentAdoptionPorts } from '../src/main/agent-adoption-host.js';
import { moveAgentFrontmatter } from '../src/main/agent-config-host.js';
import { createAgent, type AgentCreatePorts } from '../src/main/agent-create-host.js';

/**
 * AN AGENT'S CONFIG LIVES IN project.json, ITS PERSONA IN AGENT.md (Tynn #694; the owner, 2026-11-13: "agent config should
 * be in the project.json, not in the AGENT.md file as frontmatter. This duplicates context and bloats the window.").
 *
 * - `agents.<name>` in project.json (Civicognita/shared-schemas v0.4.0): `{ purpose, provider?, tuis?, model? }`, nothing else.
 * - AGENT.md is ONLY the persona: no front matter, and the purpose said once — never "You are lift. <purpose>" beside a
 *   `purpose:` line saying it again.
 * - An AGENT.md that still opens with front matter is MOVED the first time Genie reads its workspace: the config into
 *   project.json (one already there wins), every other key of project.json kept, THEN the front matter stripped. After
 *   that, front matter is never read.
 */

const SCHEMA = (v: string) => `https://raw.githubusercontent.com/Civicognita/shared-schemas/v${v}/schemas/workspace/project.schema.json`;
const LIFT_PURPOSE = 'You are the builder and maintainer of the Liftpoint Solutions App (details in tynn). Your job is to maintain proper localized CI with TDD and Recursive Self Improvement.';
/** liftpoint.agi's lift, as Genie wrote it before #694 — the owner's example. */
const LIFT = `---\nname: lift\npurpose: ${LIFT_PURPOSE}\ntuis: [claude]\n---\nYou are lift. ${LIFT_PURPOSE}\n`;
/** homeward-bound.agi's guide: front matter, then the person's own prose. */
const GUIDE_PROSE = 'You are **the Guide** for Homeward Bound: an app that helps a person find their\nideal home.\n\n## Rules\n\nUse the tools.\n';
const GUIDE = `---\nname: guide\npurpose: Helps the user find their way home.\ntuis:\n  - Codex\n  - claude\n---\n\n${GUIDE_PROSE}`;
/** aipa.agi's maipa: no front matter at all. */
const MAIPA = '# Maipa - My AI Professional Accountant\n\nYour name is **Maipa**.\n';

describe('the persona file (pure)', () => {
    it('a new AGENT.md is the purpose, once: no front matter, no "You are <name>." repeating it', () => {
        const text = agentFileText({ name: 'scout', purpose: '  Reads issues\n and triages them. ' });
        expect(text).toBe('Reads issues and triages them.\n');
        expect(text).not.toMatch(/^---/);
        expect(text).not.toContain('You are scout');
    });

    it('moves lift: tuis and purpose become config, the persona is the purpose said ONCE', () => {
        const move = frontmatterMove(LIFT, 'lift');
        expect(move).toEqual({ config: { purpose: LIFT_PURPOSE, tuis: ['claude'] }, persona: `${LIFT_PURPOSE}\n` });
    });

    it('moves a file whose body is the person’s own prose: the prose is kept verbatim, a dash list of tuis is read', () => {
        expect(frontmatterMove(GUIDE, 'guide')).toEqual({ config: { purpose: 'Helps the user find their way home.', tuis: ['codex', 'claude'] }, persona: GUIDE_PROSE });
    });

    it('a file with no front matter has nothing to move (null) — it is already only a persona', () => {
        expect(frontmatterMove(MAIPA, 'maipa')).toBeNull();
        expect(frontmatterMove('', 'maipa')).toBeNull();
    });

    it('CRLF files move too, and keep their line endings', () => {
        const crlf = LIFT.replace(/\n/g, '\r\n');
        expect(frontmatterMove(crlf, 'lift')).toEqual({ config: { purpose: LIFT_PURPOSE, tuis: ['claude'] }, persona: `${LIFT_PURPOSE}\r\n` });
    });

    it('front matter with no purpose: the purpose is the persona’s first line (its "You are <name>." dropped), else the name', () => {
        expect(frontmatterMove('---\ntuis: [codex]\n---\n\n# Persona\n\nDoes the work.\n', 'bolt')).toEqual({ config: { purpose: 'Does the work.', tuis: ['codex'] }, persona: '# Persona\n\nDoes the work.\n' });
        expect(frontmatterMove('---\nname: hydro\n---\nYou are hydro. Builds the ERP\n', 'hydro')).toEqual({ config: { purpose: 'Builds the ERP' }, persona: 'Builds the ERP\n' });
        expect(frontmatterMove('---\nname: empty\n---\n', 'empty')).toEqual({ config: { purpose: 'empty' }, persona: 'empty\n' });
    });

    it('provider and model in old front matter are moved as config; anything else there (a secret, say) is never carried', () => {
        const move = frontmatterMove('---\nname: x\npurpose: P\nprovider: codex\nmodel: gpt-5\napiKey: sk-secret\n---\nP\n', 'x');
        expect(move?.config).toEqual({ purpose: 'P', provider: 'codex', model: 'gpt-5' });
        expect(JSON.stringify(move)).not.toContain('sk-secret');
    });
});

describe('agents in project.json (pure)', () => {
    const doc = { $schema: SCHEMA('0.3.0'), name: 'Liftpoint', repos: [{ name: 'app', path: 'repos/app', futureKey: 1 }], appearance: { color: '#3b82f6' }, futureOwner: { keep: true }, agents: { reviewer: { purpose: 'Reviews.', provider: 'codex' } } };
    const text = `${JSON.stringify(doc, null, 4)}\n`;

    it('this Genie writes shared-schemas v0.4.0 (the revision that declares agents)', () => {
        expect(SCHEMA_REVISION).toBe('0.4.0');
    });

    it('sets one agent, keeps every other key and every other agent, stamps v0.4.0, in the file’s own indentation', () => {
        const r = agentConfigWrite(text, { lift: { purpose: LIFT_PURPOSE, tuis: ['claude'] } });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.changed).toBe(true);
        expect(r.backup).toBeNull();
        expect(JSON.parse(r.text)).toEqual({ ...doc, $schema: SCHEMA('0.4.0'), agents: { reviewer: { purpose: 'Reviews.', provider: 'codex' }, lift: { purpose: LIFT_PURPOSE, tuis: ['claude'] } } });
        expect(r.text).toMatch(/^\{\n {4}"\$schema"/);
        expect(r.text.endsWith('}\n')).toBe(true);
    });

    it('CRLF stays CRLF', () => {
        const r = agentConfigWrite(text.replace(/\n/g, '\r\n'), { lift: { purpose: 'L' } });
        expect(r.ok && r.text.includes('\r\n') && !/[^\r]\n/.test(r.text)).toBe(true);
    });

    it('keepExisting: an entry already in project.json wins over the one offered (the move never overrides)', () => {
        const r = agentConfigWrite(text, { reviewer: { purpose: 'From old front matter', tuis: ['claude'] } }, { keepExisting: true });
        expect(r).toMatchObject({ ok: true, changed: false });
        expect(r.ok && JSON.parse(r.text).agents.reviewer).toEqual({ purpose: 'Reviews.', provider: 'codex' });
    });

    it('only config is written: an unknown key offered for an agent (a secret, persona prose) never reaches the file', () => {
        const r = agentConfigWrite(text, { lift: { purpose: 'L', apiKey: 'sk-secret', persona: 'You are lift.' } as never });
        expect(r.ok && JSON.parse(r.text).agents.lift).toEqual({ purpose: 'L' });
        expect(r.ok && r.text).not.toContain('sk-secret');
    });

    it('refuses — and so writes nothing — for no project.json, invalid JSON, a newer schema, a bad name or no purpose', () => {
        expect(agentConfigWrite(null, { lift: { purpose: 'L' } })).toMatchObject({ ok: false });
        expect(agentConfigWrite('{ nope', { lift: { purpose: 'L' } })).toMatchObject({ ok: false });
        expect(agentConfigWrite(JSON.stringify({ $schema: SCHEMA('0.5.0') }), { lift: { purpose: 'L' } })).toMatchObject({ ok: false, reason: expect.stringMatching(/newer/) });
        expect(agentConfigWrite(text, { Lift: { purpose: 'L' } })).toMatchObject({ ok: false });
        expect(agentConfigWrite(text, { lift: { purpose: '  ' } })).toMatchObject({ ok: false });
    });

    it('an unstamped legacy file gets MIGRATIONS.md’s backup', () => {
        const legacy = '{\n  "name": "Old"\n}\n';
        const r = agentConfigWrite(legacy, { lift: { purpose: 'L' } });
        expect(r.ok && r.backup).toEqual({ name: 'project.json.pre-schema-0.4.0.bak', text: legacy });
    });

    it('reads only the four config keys of each well-formed entry; a malformed entry or name is ignored, not guessed at', () => {
        expect(agentConfigsOf({ agents: { lift: { purpose: 'L', tuis: ['claude'], model: 'opus', apiKey: 'x' }, bad: { provider: 'claude' }, Nope: { purpose: 'p' }, odd: 'p', t: { purpose: 'p', tuis: 'claude' } } }))
            .toEqual({ lift: { purpose: 'L', tuis: ['claude'], model: 'opus' } });
        expect(agentConfigsOf(null)).toEqual({});
        expect(agentConfigsOf({ agents: [] })).toEqual({});
    });
});

/** A workspace on disk: its files by path, every write recorded. */
function disk(files: Record<string, string>) {
    const writes: string[] = [];
    const key = (p: string) => p.replace(/\\/g, '/');
    const fs = {
        files,
        writes,
        listDirs: async (dir: string) => {
            const prefix = `${key(dir)}/`;
            const names = new Set(Object.keys(files).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0]!));
            if (names.size === 0) throw new Error('ENOENT');
            return [...names];
        },
        readText: async (path: string) => files[key(path)] ?? null,
        writeTextAtomic: async (path: string, text: string) => { writes.push(key(path)); files[key(path)] = text; },
    };
    return fs;
}

const ROOT = '/w/liftpoint.agi';
const PROJECT = `${JSON.stringify({ $schema: SCHEMA('0.3.0'), name: 'Liftpoint', futureOwner: { keep: true }, tynn: { projectId: '42' } }, null, 2)}\n`;

describe('the one-time move, on the host', () => {
    it('moves lift’s front matter into project.json, then strips it; a file without front matter is not touched', async () => {
        const fs = disk({ [`${ROOT}/project.json`]: PROJECT, [`${ROOT}/.agents/lift/AGENT.md`]: LIFT, [`${ROOT}/.agents/maipa/AGENT.md`]: MAIPA, [`${ROOT}/.agents/_genie/shared.md`]: 'x' });
        const r = await moveAgentFrontmatter(fs, ROOT);
        expect(r).toEqual({ ok: true, moved: ['lift'] });
        // project.json FIRST, then the persona: a failure between them leaves the config twice, never nowhere.
        expect(fs.writes).toEqual([`${ROOT}/project.json`, `${ROOT}/.agents/lift/AGENT.md`]);
        expect(JSON.parse(fs.files[`${ROOT}/project.json`]!)).toEqual({ $schema: SCHEMA('0.4.0'), name: 'Liftpoint', futureOwner: { keep: true }, tynn: { projectId: '42' }, agents: { lift: { purpose: LIFT_PURPOSE, tuis: ['claude'] } } });
        expect(fs.files[`${ROOT}/.agents/lift/AGENT.md`]).toBe(`${LIFT_PURPOSE}\n`);
        expect(fs.files[`${ROOT}/.agents/maipa/AGENT.md`]).toBe(MAIPA);
    });

    it('a second read moves nothing and writes nothing (front matter is never read again)', async () => {
        const fs = disk({ [`${ROOT}/project.json`]: PROJECT, [`${ROOT}/.agents/lift/AGENT.md`]: LIFT });
        await moveAgentFrontmatter(fs, ROOT);
        const after = fs.writes.length;
        expect(await moveAgentFrontmatter(fs, ROOT)).toEqual({ ok: true, moved: [] });
        expect(fs.writes.length).toBe(after);
    });

    it('several agents land in ONE project.json write; an entry already there wins over its old front matter', async () => {
        const project = `${JSON.stringify({ $schema: SCHEMA('0.4.0'), name: 'L', agents: { guide: { purpose: 'Set in project.json', provider: 'codex' } } }, null, 2)}\n`;
        const fs = disk({ [`${ROOT}/project.json`]: project, [`${ROOT}/.agents/lift/AGENT.md`]: LIFT, [`${ROOT}/.agents/guide/AGENT.md`]: GUIDE });
        expect(await moveAgentFrontmatter(fs, ROOT)).toEqual({ ok: true, moved: ['guide', 'lift'] });
        expect(fs.writes.filter((p) => p.endsWith('project.json'))).toHaveLength(1);
        expect(JSON.parse(fs.files[`${ROOT}/project.json`]!).agents).toEqual({ guide: { purpose: 'Set in project.json', provider: 'codex' }, lift: { purpose: LIFT_PURPOSE, tuis: ['claude'] } });
        expect(fs.files[`${ROOT}/.agents/guide/AGENT.md`]).toBe(GUIDE_PROSE);
    });

    it('no project.json, or one on a newer schema: NOTHING is written — the front matter stays rather than being lost', async () => {
        const none = disk({ [`${ROOT}/.agents/lift/AGENT.md`]: LIFT });
        expect(await moveAgentFrontmatter(none, ROOT)).toMatchObject({ ok: false });
        expect(none.writes).toEqual([]);
        const newer = disk({ [`${ROOT}/project.json`]: JSON.stringify({ $schema: SCHEMA('0.5.0') }), [`${ROOT}/.agents/lift/AGENT.md`]: LIFT });
        expect(await moveAgentFrontmatter(newer, ROOT)).toMatchObject({ ok: false, reason: expect.stringMatching(/newer/) });
        expect(newer.writes).toEqual([]);
        expect(newer.files[`${ROOT}/.agents/lift/AGENT.md`]).toBe(LIFT);
    });

    it('a folder that is not an agent name Genie takes is left alone', async () => {
        const fs = disk({ [`${ROOT}/project.json`]: PROJECT, [`${ROOT}/.agents/My Agent/AGENT.md`]: LIFT });
        expect(await moveAgentFrontmatter(fs, ROOT)).toEqual({ ok: true, moved: [] });
        expect(fs.writes).toEqual([]);
    });

    it('a workspace with no .agents/ has nothing to move', async () => {
        const fs = disk({ [`${ROOT}/project.json`]: PROJECT });
        expect(await moveAgentFrontmatter(fs, ROOT)).toEqual({ ok: true, moved: [] });
        expect(fs.writes).toEqual([]);
    });
});

describe('creating an agent writes its config to project.json and only its persona to AGENT.md', () => {
    const ports = (files: Record<string, string>) => {
        const fs = disk(files);
        const registered: unknown[] = [];
        const p: AgentCreatePorts = {
            workspace: (id) => (id === 'lp' ? { id: 'lp', path: ROOT } : null),
            agentsOf: () => [],
            exists: async (path) => fs.files[path.replace(/\\/g, '/')] !== undefined,
            mkdirp: async () => {},
            listDirs: fs.listDirs,
            readText: fs.readText,
            writeTextAtomic: fs.writeTextAtomic,
            register: async (input) => { registered.push(input); return { id: 'agent_new', name: input.name }; },
            sacredName: async () => null,
        };
        return { p, fs, registered };
    };

    it('scout: project.json gains agents.scout {purpose, provider}; AGENT.md is the purpose once; then it registers', async () => {
        const { p, fs, registered } = ports({ [`${ROOT}/project.json`]: PROJECT });
        expect(await createAgent(p, 'lp', { name: 'Scout', purpose: 'Reads issues and triages them.', provider: 'codex' })).toEqual({ ok: true, id: 'agent_new', name: 'scout' });
        expect(JSON.parse(fs.files[`${ROOT}/project.json`]!)).toEqual({ $schema: SCHEMA('0.4.0'), name: 'Liftpoint', futureOwner: { keep: true }, tynn: { projectId: '42' }, agents: { scout: { purpose: 'Reads issues and triages them.', provider: 'codex' } } });
        expect(fs.files[`${ROOT}/.agents/scout/AGENT.md`]).toBe('Reads issues and triages them.\n');
        expect(registered).toEqual([{ workspaceId: 'lp', provider: 'codex', name: 'scout', instructions: '.agents/scout/AGENT.md' }]);
    });

    it('a project.json Genie may not write (none, newer schema): nothing is written and nothing registered, and it says why', async () => {
        const none = ports({});
        expect(await createAgent(none.p, 'lp', { name: 'scout', purpose: 'P', provider: 'claude' })).toMatchObject({ ok: false, reason: expect.stringMatching(/project\.json/) });
        expect(none.fs.writes).toEqual([]);
        expect(none.registered).toEqual([]);
        const newer = ports({ [`${ROOT}/project.json`]: JSON.stringify({ $schema: SCHEMA('0.5.0') }) });
        expect(await createAgent(newer.p, 'lp', { name: 'scout', purpose: 'P', provider: 'claude' })).toMatchObject({ ok: false, reason: expect.stringMatching(/newer/) });
        expect(newer.fs.writes).toEqual([]);
        expect(newer.registered).toEqual([]);
    });

    it('an AGENT.md already there is never overwritten; its config still lands in project.json', async () => {
        const { p, fs } = ports({ [`${ROOT}/project.json`]: PROJECT, [`${ROOT}/.agents/scout/AGENT.md`]: 'their own words\n' });
        expect(await createAgent(p, 'lp', { name: 'scout', purpose: 'P', provider: 'claude' })).toMatchObject({ ok: true });
        expect(fs.files[`${ROOT}/.agents/scout/AGENT.md`]).toBe('their own words\n');
        expect(JSON.parse(fs.files[`${ROOT}/project.json`]!).agents.scout).toEqual({ purpose: 'P', provider: 'claude' });
    });
});

describe('adopting reads the provider from project.json — after moving any front matter there', () => {
    const ports = (files: Record<string, string>) => {
        const fs = disk(files);
        const registered: Array<{ provider: string; name: string }> = [];
        const p: AgentAdoptionPorts = {
            workspace: (id) => (id === 'lp' ? { id: 'lp', path: ROOT } : null),
            agentsOf: () => [],
            listDirs: fs.listDirs,
            readText: fs.readText,
            writeTextAtomic: fs.writeTextAtomic,
            register: async (input) => { registered.push(input); return { id: `agent_${input.name}`, name: input.name }; },
            sacredName: async () => null,
        };
        return { p, fs, registered };
    };

    it('listing a workspace IS reading it: guide’s front matter moves, and its provider comes from the moved tuis', async () => {
        const { p, fs } = ports({ [`${ROOT}/project.json`]: PROJECT, [`${ROOT}/.agents/guide/AGENT.md`]: GUIDE, [`${ROOT}/.agents/maipa/AGENT.md`]: MAIPA });
        const r = await readImportedAgents(p, 'lp');
        expect(r).toMatchObject({ ok: true, agents: [{ name: 'guide', provider: 'codex', refusal: null }, { name: 'maipa', provider: 'claude', refusal: null }] });
        expect(fs.files[`${ROOT}/.agents/guide/AGENT.md`]).toBe(GUIDE_PROSE);
        expect(JSON.parse(fs.files[`${ROOT}/project.json`]!).agents.guide).toEqual({ purpose: 'Helps the user find their way home.', tuis: ['codex', 'claude'] });
    });

    it('project.json’s provider wins over its tuis; the AGENT.md text is never read for config again', async () => {
        const project = `${JSON.stringify({ $schema: SCHEMA('0.4.0'), name: 'L', agents: { maipa: { purpose: 'Accounts.', provider: 'codex', tuis: ['claude'] } } }, null, 2)}\n`;
        // Its tuis would hint claude; its provider says codex, and the provider is the record of what it runs on.
        const { p, registered } = ports({ [`${ROOT}/project.json`]: project, [`${ROOT}/.agents/maipa/AGENT.md`]: MAIPA });
        expect(await adoptAgent(p, 'lp', 'maipa')).toEqual({ ok: true, id: 'agent_maipa', name: 'maipa' });
        expect(registered).toEqual([{ workspaceId: 'lp', provider: 'codex', name: 'maipa', instructions: '.agents/maipa/AGENT.md' }]);
    });
});
