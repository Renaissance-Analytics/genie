import { describe, expect, it } from 'vitest';
import {
    adoptableAgents,
    adoptionRequest,
    agentFilesIn,
    workspaceRoster,
    type AgentFileOnDisk,
    type AgentFilesFs,
    type RegisteredAgentSummary,
} from '../roster';

/**
 * `.agents/<slug>/AGENT.md` has a WRITER and, until now, no reader.
 *
 * `deletion.ts:71` states the intent outright — *"UNMOUNT never removes a file —
 * keeping every `.agents/*` file is the entire point"* — and nothing in the
 * codebase ever read that directory back. So the durable half of an agent
 * survived every unmount, every re-add and every clone onto another machine, and
 * could not be turned back into an agent by anything. The owner has three of
 * them sitting on disk right now (genie#465).
 *
 * This module is that reader: what is on disk, what the registry knows, and
 * which files are OFFERED for adoption. It adopts nothing — offering is the
 * design, and adopting without asking is not.
 */

const file = (folder: string, raw: string): AgentFileOnDisk => ({
    folder,
    personaPath: `C:/ws/.agents/${folder}/AGENT.md`,
    raw,
    config: { name: '', purpose: '', scope: null, tuis: [], avatar: null, mode: null },
});

/** A fake tree, keyed by absolute path. */
function fsWith(tree: Record<string, string>): AgentFilesFs {
    return {
        listDirs: (dir) =>
            Object.keys(tree)
                .filter((p) => p.startsWith(`${dir}/`))
                .map((p) => p.slice(dir.length + 1).split('/')[0]!)
                .filter((v, i, a) => a.indexOf(v) === i),
        readFile: (p) => tree[p] ?? null,
    };
}

const registered = (over: Partial<RegisteredAgentSummary> = {}): RegisteredAgentSummary => ({
    id: 'a1',
    name: 'builder',
    purpose: 'Builds the thing',
    role: 'specialized',
    tui: 'claude',
    running: false,
    ...over,
});

describe('reading .agents off disk', () => {
    it('finds a folder that holds an AGENT.md', () => {
        const found = agentFilesIn(
            'C:/ws',
            fsWith({
                'C:/ws/.agents/ripple/AGENT.md': '# Ripple\n',
                'C:/ws/.agents/ripple-builder/AGENT.md': '---\nname: ripple-builder\n---\nbody\n',
            }),
        );
        expect(found.map((f) => f.folder)).toEqual(['ripple', 'ripple-builder']);
        expect(found[1]!.config.name).toBe('ripple-builder');
    });

    /**
     * `.agents/` is NOT only agents. This envelope's own copy holds `_genie/`
     * (shared instructions) and `skills/` (SKILL.md files) beside `tynn/`, and a
     * scan that treated every subfolder as an agent would offer to adopt both.
     * The AGENT.md is what makes a folder an agent.
     */
    it('ignores a folder with no AGENT.md — .agents also holds skills and shared instructions', () => {
        const found = agentFilesIn(
            'C:/ws',
            fsWith({
                'C:/ws/.agents/_genie/shared.md': 'protocol',
                'C:/ws/.agents/skills/genie/SKILL.md': 'skill',
                'C:/ws/.agents/tynn/AGENT.md': '---\nname: tynn\n---\n',
            }),
        );
        expect(found.map((f) => f.folder)).toEqual(['tynn']);
    });

    it('answers empty for a workspace with no .agents at all, rather than throwing', () => {
        expect(agentFilesIn('C:/ws', fsWith({}))).toEqual([]);
        const exploding: AgentFilesFs = {
            listDirs: () => {
                throw new Error('EACCES');
            },
            readFile: () => null,
        };
        expect(agentFilesIn('C:/ws', exploding)).toEqual([]);
    });
});

describe('the roster: what is registered, and what is only on disk', () => {
    it('marks an agent that is both registered and on disk', () => {
        const roster = workspaceRoster({
            registered: [registered({ name: 'ripple-builder' })],
            files: [file('ripple-builder', '---\nname: ripple-builder\n---\n')],
        });
        expect(roster).toHaveLength(1);
        expect(roster[0]).toMatchObject({ name: 'ripple-builder', registered: true, onDisk: true });
        expect(roster[0]!.agentId).toBe('a1');
    });

    /**
     * WHETHER IT IS UP — genie#474.
     *
     * The roster offered Start and nothing for the other direction, and the
     * reason it could not offer Stop was not only that the path was missing:
     * the list did not know which agents were running, so it could not have
     * said which button to draw. Carried through here because the roster is
     * where a human sees the whole workspace at once.
     */
    it('carries whether a registered agent is running', () => {
        const roster = workspaceRoster({
            registered: [
                registered({ id: 'up', name: 'moic', running: true }),
                registered({ id: 'down', name: 'trader', running: false }),
            ],
            files: [],
        });
        expect(roster.find((e) => e.name === 'moic')!.running).toBe(true);
        // POSITIVE CONTROL: a hard-coded `running: true` would pass the line
        // above on every roster ever rendered.
        expect(roster.find((e) => e.name === 'trader')!.running).toBe(false);
    });

    it('never claims an UNREGISTERED file is running', () => {
        // There is no process behind a file the registry has never heard of, so
        // the row must not carry a state that would draw a Stop button.
        const roster = workspaceRoster({ registered: [], files: [file('ripple', '# Ripple\n')] });
        expect(roster[0]!.running).toBe(false);
    });

    it('lists a registered agent whose file is gone, and says the file is gone', () => {
        const roster = workspaceRoster({
            registered: [registered({ name: 'commander' })],
            files: [],
        });
        expect(roster[0]).toMatchObject({ name: 'commander', registered: true, onDisk: false });
    });

    /** The whole point: the file the owner still has, offered back. */
    it('offers an on-disk agent the registry has never heard of', () => {
        const roster = workspaceRoster({
            registered: [registered({ name: 'ripple-builder' })],
            files: [file('ripple', '# Ripple — the director\n'), file('ripple-builder', '')],
        });
        expect(adoptableAgents(roster).map((e) => e.name)).toEqual(['ripple']);
    });

    it('keeps the registry order, then the adoptable ones by name', () => {
        const roster = workspaceRoster({
            registered: [
                registered({ id: 'w', name: 'zeta', role: 'workspace' }),
                registered({ id: 's', name: 'alpha' }),
            ],
            files: [file('yankee', ''), file('bravo', '')],
        });
        expect(roster.map((e) => e.name)).toEqual(['zeta', 'alpha', 'bravo', 'yankee']);
    });

    it('refuses to offer a RESERVED name — registration would refuse it anyway', () => {
        const roster = workspaceRoster({
            registered: [],
            files: [file('genie', ''), file('tynn', '')],
        });
        expect(adoptableAgents(roster)).toEqual([]);
        expect(roster[0]!.refusal).toMatch(/reserved/i);
    });

    it('offers the ONE reserved term a sacred workspace was granted', () => {
        const roster = workspaceRoster({
            registered: [],
            files: [file('tynn', ''), file('genie', '')],
            sacredName: 'tynn',
        });
        // Granted `tynn` — and that grant is not a skeleton key for `genie`.
        expect(adoptableAgents(roster).map((e) => e.name)).toEqual(['tynn']);
    });

    /**
     * A folder that is not already a valid agent name cannot be adopted in
     * place: registration derives the path from `agentName(name)`, so adopting
     * `My Agent` would write a SECOND folder, `my-agent`, and leave the original
     * orphaned exactly as it was. Say so, and name the folder it needs to be.
     */
    it('refuses a folder whose name is not the slug registration would use', () => {
        const roster = workspaceRoster({ registered: [], files: [file('My Agent', '')] });
        expect(adoptableAgents(roster)).toEqual([]);
        expect(roster[0]!.refusal).toContain('my-agent');
    });
});

describe('turning a file into a registration', () => {
    it('takes the purpose, driver and scope the FILE states', () => {
        const req = adoptionRequest({
            ...file('twenty', ''),
            config: {
                name: 'twenty',
                purpose: 'Works the CRM in this app',
                scope: 'apps/crm',
                tuis: ['codex', 'claude'],
                avatar: null,
                mode: null,
            },
        });
        expect(req).toEqual({
            name: 'twenty',
            purpose: 'Works the CRM in this app',
            agent: 'codex',
            bootFolder: 'apps/crm',
        });
    });

    /**
     * Two of the owner's three orphans have NO frontmatter at all — `trader` and
     * `ripple` are hand-authored personas that Genie never wrote (registration
     * always renders a header). Registration REQUIRES a purpose, so an adoption
     * that could not supply one would refuse exactly the files this whole
     * feature exists for.
     *
     * The fallback is the file's own H1: the author's words, rather than an
     * invented claim about what the agent does.
     */
    it('falls back to the file own heading when it states no purpose', () => {
        const req = adoptionRequest(
            file('ripple', '# Ripple — the director\n\nYou are **Ripple**.\n'),
        );
        expect(req.purpose).toBe('Ripple — the director');
        // Nothing invented about the driver: the workstation default applies.
        expect(req.agent).toBeUndefined();
        expect(req.bootFolder).toBeUndefined();
    });

    it('says where it came from when the file states neither', () => {
        const req = adoptionRequest(file('trader', 'You are this operator trading agent.\n'));
        expect(req.purpose).toContain('.agents/trader/AGENT.md');
    });

    it('never names a driver the registry does not know', () => {
        const req = adoptionRequest({
            ...file('x', ''),
            config: {
                name: 'x',
                purpose: 'p',
                scope: null,
                tuis: ['notatui'],
                avatar: null,
                mode: null,
            },
        });
        expect(req.agent).toBeUndefined();
    });
});
