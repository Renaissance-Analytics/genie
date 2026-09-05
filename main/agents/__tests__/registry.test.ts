import { describe, expect, it, vi } from 'vitest';

import {
    PROVIDER_IDS,
    TUI_REGISTRY,
    agentTuis,
    providerDef,
    tuiSettingDefaults,
    providerSettingKeys,
    canResumeTui,
} from '../registry';
import { renderAgentResume } from '../../agentinbox/session-capture';
import { agentName, isAgentTui } from '../identity';
import { AGENT_TUIS } from '../tui';
import { savedAgentsOf } from '../saved';
import { resolveAgentCommand } from '../command';
import { handleMcpMessage, type McpContext } from '../../mcp/protocol';

/**
 * ONE place defines a tui (genie#261).
 *
 * Before this, the tui set was a string-literal union restated in ~37
 * places, of which only ~11 were compiler-enforced. The unenforced ones are the
 * reason this exists: they do not fail to build, they fail to WORK, silently.
 *
 * These tests are all the same shape on purpose — every surface that names the
 * providers must equal `Object.keys(TUI_REGISTRY)`. That is the property
 * that makes adding a tui DATA rather than a sweep: any surface still
 * carrying its own literal diverges from the registry the moment one is added,
 * and says so here.
 */

const REGISTRY_IDS = Object.keys(TUI_REGISTRY).sort();

/**
 * Read the REAL advertised `runAgent` schema through `tools/list`, the way
 * `guide-sync.test.ts` does — this is what an MCP client actually receives, so a
 * schema that drifts from the registry fails here rather than at a client.
 */
async function advertisedAgentEnum(): Promise<string[]> {
    const ctx = { terminalId: 'term-1', serverName: 'genie', serverVersion: '0.0.0-test',
        runAgent: vi.fn(), isOpsProject: vi.fn().mockResolvedValue(false) } as unknown as McpContext;
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx);
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    const tool = tools.find((t) => t.name === 'runAgent');
    if (!tool) throw new Error('runAgent tool not advertised');
    const props = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties;
    return props?.agent?.enum ?? [];
}

async function advertisedAgentTools(): Promise<Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>> {
    const ctx = {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.0.0-test',
        registerAgent: vi.fn(),
        runAgent: vi.fn(),
        isOpsProject: vi.fn().mockResolvedValue(false),
    } as unknown as McpContext;
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx);
    return (res?.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).tools;
}

describe('the registry is the source of truth', () => {
    it('knows the providers Genie ships', () => {
        // The snapshot. Adding or removing a provider is a product decision, so
        // it should have to be typed here on purpose rather than absorbed.
        expect(REGISTRY_IDS).toEqual([
            'aider',
            'amp',
            'auggie',
            'claude',
            'cline',
            'codex',
            'continue',
            'copilot',
            'crush',
            'cursor',
            'custom',
            'droid',
            'gemini',
            'genie',
            'goose',
            'iflow',
            'kilo',
            'kimi',
            'opencode',
            'qwen',
            'vibe',
        ]);
    });

    it('gives every tui a complete definition', () => {
        for (const id of agentTuis()) {
            const def = providerDef(id);
            expect(def.id, `${id}.id`).toBe(id);
            expect(def.label.trim(), `${id}.label`).not.toBe('');
            expect(def.commandSettingKey, `${id}.commandSettingKey`).toBe(`agent_command_${id}`);
            expect(def.flagsSettingKey, `${id}.flagsSettingKey`).toBe(`agent_flags_${id}`);
        }
    });

    it('lists providers in a stable order, so every derived UI agrees', () => {
        // The two that have always shipped, then Genie's own, then
        // alphabetical, then `custom` — which is not a product and belongs last.
        expect(agentTuis().slice(0, 3)).toEqual(['claude', 'codex', 'genie']);
        expect(agentTuis().at(-1)).toBe('custom');
        const middle = agentTuis().slice(3, -1);
        expect(middle, 'the field is alphabetical').toEqual([...middle].sort());
        expect(agentTuis()).toEqual([...PROVIDER_IDS]);
        expect(agentTuis()).toEqual(Object.keys(TUI_REGISTRY));
    });
});

describe('every tui list is DERIVED, not restated', () => {
    it('advertises registration separately and keeps runAgent start-only for creation', async () => {
        const tools = await advertisedAgentTools();
        const register = tools.find((tool) => tool.name === 'registerAgent');
        const run = tools.find((tool) => tool.name === 'runAgent');

        expect(register).toBeDefined();
        expect(register?.inputSchema.properties).toHaveProperty('purpose');
        expect(register?.inputSchema.properties).toHaveProperty('avatar');
        expect(register?.inputSchema.properties).toHaveProperty('bootFolder');
        expect(run?.inputSchema.properties).not.toHaveProperty('create');
    });

    /**
     * `main/agents/identity.ts` carried `const PROVIDERS: readonly string[]`,
     * deliberately outside the union so the compiler could not check it. That is
     * the single worst site in genie#261 — see the regression below.
     */
    it('identity.isAgentTui accepts exactly the registry', () => {
        for (const id of agentTuis()) {
            expect(isAgentTui(id), `isAgentTui(${id})`).toBe(true);
        }
        for (const notOne of ['notatui', 'kiwi', 'definitely-not-a-provider', '', 'CLAUDE']) {
            expect(isAgentTui(notOne), `isAgentTui(${notOne})`).toBe(false);
        }
    });

    it('tui.AGENT_TUIS is the registry', () => {
        expect([...AGENT_TUIS].sort()).toEqual(REGISTRY_IDS);
    });

    /**
     * The MCP JSON-Schema `enum`. Miss this one and an agent cannot NAME the
     * tui over the wire, whatever the TypeScript says.
     */
    it('the runAgent tool schema enum is the registry', async () => {
        expect((await advertisedAgentEnum()).sort()).toEqual(REGISTRY_IDS);
    });

    /**
     * The DEFAULTS block in `db.ts` listed all six keys by hand. A tui added
     * without its two lines gets `undefined` where a string is expected.
     */
    it('the settings defaults cover every tui, with the registry command', () => {
        const defaults = tuiSettingDefaults();
        for (const id of agentTuis()) {
            const def = providerDef(id);
            expect(defaults[def.commandSettingKey], `${id} command default`).toBe(
                def.defaultCommand,
            );
            expect(defaults[def.flagsSettingKey], `${id} flags default`).toBe('');
        }
        expect(Object.keys(defaults)).toHaveLength(agentTuis().length * 2);
    });

    it('the settings keys are the registry', () => {
        const keys = providerSettingKeys();
        expect(keys.map((k) => k.command).sort()).toEqual(
            REGISTRY_IDS.map((id) => `agent_command_${id}`),
        );
        expect(keys.map((k) => k.flags).sort()).toEqual(
            REGISTRY_IDS.map((id) => `agent_flags_${id}`),
        );
    });
});

describe('the default command comes from the registry', () => {
    /**
     * `resolveAgentCommand` was an if/else ladder with `'claude'` and `'codex'`
     * spelled out twice each — once as the settings key and once as the fallback.
     * A tui added without a rung here resolves to null and simply does not
     * launch.
     */
    it('resolves every tui to its registry default when nothing is configured', () => {
        for (const id of agentTuis()) {
            const def = providerDef(id);
            const resolved = resolveAgentCommand(id, undefined, {});
            if (def.defaultCommand) {
                expect(resolved, `${id} default`).toBe(def.defaultCommand);
            } else {
                // `custom` has no built-in default on purpose — guessing one
                // would launch the wrong thing.
                expect(resolved, `${id} has no default`).toBeNull();
            }
        }
    });

    it('prefers an explicit override over everything', () => {
        expect(resolveAgentCommand('claude', '  my-claude  ', {})).toBe('my-claude');
    });

    it('prefers the configured setting over the registry default', () => {
        expect(resolveAgentCommand('claude', undefined, { agent_command_claude: 'claude-next' }))
            .toBe('claude-next');
    });

    it('falls back to the registry default when the setting is blank', () => {
        expect(resolveAgentCommand('claude', undefined, { agent_command_claude: '   ' }))
            .toBe('claude');
    });
});

describe('the silent skip this refactor exists to close', () => {
    /**
     * The worked example from genie#261.
     *
     * `savedAgentsOf` gates on `isAgentTui(spec.meta.agent)`. When that read
     * its own literal, a tui added everywhere ELSE — union widened, launch
     * profile added, settings added, UI added — would still be dropped here, with
     * **no error anywhere**: the agent simply never appeared in the roster.
     *
     * Deriving the guard from the registry makes that unreachable: if it is in
     * the registry it is a tui, by construction.
     */
    it('lists a saved agent for EVERY tui in the registry', () => {
        const specs = agentTuis().map((tui, i) => ({
            id: `spec-${i}`,
            workspace_id: 'ws-1',
            meta: { agent: tui, whisper_purpose: 'tynn', agent_id: `agent-${i}` },
        }));

        const found = savedAgentsOf(specs, 'ws-1', () => false);

        expect(found.map((a) => a.tui)).toEqual(agentTuis());
        expect(found).toHaveLength(Object.keys(TUI_REGISTRY).length);
    });

    it('still drops a spec whose agent is not a tui at all', () => {
        const found = savedAgentsOf(
            [{ id: 's1', workspace_id: 'ws-1', meta: { agent: 'notatui' } }],
            'ws-1',
            () => false,
        );
        expect(found).toEqual([]);
    });

    /**
     * A positive control for the negative above: the same call shape, with a real
     * tui, must still return something. Otherwise "returns []" would also
     * pass if `savedAgentsOf` were broken outright.
     */
    it('positive control — the same shape with a real tui is kept', () => {
        const found = savedAgentsOf(
            [{ id: 's1', workspace_id: 'ws-1', meta: { agent: 'claude' } }],
            'ws-1',
            () => false,
        );
        expect(found).toHaveLength(1);
        expect(found[0]?.name).toBe(agentName(undefined));
    });
});

/**
 * A tui's `defaultCommand` is the BINARY Genie will actually exec.
 *
 * `genie` shipped as `genie-tui`, which does not exist — selecting the Genie TUI
 * produced `bash: genie-tui: command not found`, so the tui was unusable
 * from the moment it appeared in the picker. Nothing caught it because nothing
 * asserted the names: a command string is only wrong at spawn time, on someone
 * else's machine.
 *
 * These pin the exact names rather than merely "non-empty", because non-empty is
 * exactly what `genie-tui` was.
 */
describe('tui default commands', () => {
    it('names the real binary for each tui', () => {
        expect(TUI_REGISTRY.claude.defaultCommand).toBe('claude');
        expect(TUI_REGISTRY.codex.defaultCommand).toBe('codex');
        expect(TUI_REGISTRY.kilo.defaultCommand).toBe('kilo');
        expect(TUI_REGISTRY.genie.defaultCommand).toBe('genie');
    });

    it('leaves `custom` empty — it has no binary of its own', () => {
        // Positive control on the rule above: "every tui names a command"
        // would be wrong here, and `custom` deliberately requires the caller to
        // supply one.
        expect(TUI_REGISTRY.custom.defaultCommand).toBe('');
    });

    it('never names a command with a `-tui` suffix', () => {
        // The specific mistake: a plausible-looking name nobody ships. Worth its
        // own assertion because the next tui added is the next chance to
        // invent one.
        for (const id of PROVIDER_IDS) {
            expect(TUI_REGISTRY[id].defaultCommand, id).not.toMatch(/-tui$/);
        }
    });
});

/**
 * genie#313 — "Genie's boot should detect whether the TUI is installed, and
 * install it if it is not." Only true for a tui GENIE ITSELF ships —
 * `claude` and `codex` are the owner's own installs (Genie must never try to
 * `npm install` someone else's CLI over their existing one), and `custom` has
 * no fixed binary to detect at all. `ownedBinary` is the flag the boot-time
 * detect-and-install pass (`agents/availability.ts`) gates on.
 */
describe('tui ownership — genie#313', () => {
    it('marks only the providers Genie ships as owned', () => {
        expect(TUI_REGISTRY.claude.ownedBinary).toBe(false);
        // Every third-party CLI is UNOWNED: the unattended boot pass must never
        // `npm i -g` over another vendor's tool. Only Genie's own TUI is owned.
        expect(TUI_REGISTRY.codex.ownedBinary).toBe(false);
        expect(TUI_REGISTRY.kilo.ownedBinary).toBe(false);
        expect(TUI_REGISTRY.genie.ownedBinary).toBe(true);
        expect(TUI_REGISTRY.custom.ownedBinary).toBe(false);
    });

    it('gives every tui an ownedBinary flag — not just the ones above', () => {
        // The Record<AgentTuiId, TuiDef> type already forces this at
        // compile time; this is the runtime witness so a tui added with an
        // `ownedBinary` left `undefined` fails LOUDLY here rather than only
        // silently skipping the boot check.
        for (const id of agentTuis()) {
            expect(typeof TUI_REGISTRY[id].ownedBinary, id).toBe('boolean');
        }
    });

    /**
     * Neither owned tui has a WORKING installer today: `genie`'s upstream
     * package (`@genie/tui`) is private and unpublished, and its shipped `bin`
     * name is still `genie-tui` — installing it as-is would silently reproduce
     * the exact naming bug this ticket's sibling already fixed, just one layer
     * later (npm would put `genie-tui` on PATH, not `genie`). It is now the
     * ONLY owned provider — `kiwi` claimed ownership of a product that does not
     * exist, and Kilo Code is Kilo's binary, not Genie's. Leaving `install` unset
     * is deliberate, so a future edit has to choose consciously.
     */
    it('leaves `install` unset until a real source exists', () => {
        expect(TUI_REGISTRY.genie.install).toBeUndefined();
        expect(TUI_REGISTRY.kilo.install).toBeUndefined();
    });

    it('never sets `install` on a tui Genie does not own', () => {
        for (const id of agentTuis()) {
            if (!TUI_REGISTRY[id].ownedBinary) {
                expect(TUI_REGISTRY[id].install, id).toBeUndefined();
            }
        }
    });
});

describe('the registry owns which tuis can RESUME (genie#261, category C)', () => {
    const SID = 'abcd1234-5678-90ab-cdef-1234567890ab';

    /**
     * The single fact behind two surfaces: the command `renderAgentResume`
     * builds, and whether the context menu offers "Restart agent" at all.
     *
     * They used to be independent claims, and they disagreed. `SpecContextMenu`
     * gated the item on `agent === 'claude'` while the renderer had been
     * emitting `codex resume <id>` the whole time — so a codex agent was denied
     * a restart that would have worked. One table, read by both, is what makes
     * that disagreement unrepresentable rather than merely unlikely.
     */
    it('agrees with renderAgentResume for EVERY registered tui', () => {
        for (const id of PROVIDER_IDS) {
            const command = renderAgentResume(id, providerDef(id).defaultCommand || id, SID);
            expect(canResumeTui(id), id).toBe(command !== null);
        }
    });

    it('renders each grammar the way that provider actually takes it', () => {
        // Positive controls with teeth: "resumable" is not enough — the command
        // has to be the one the CLI accepts, and the two providers differ.
        expect(renderAgentResume('claude', 'claude', SID)).toBe(`claude --resume ${SID}`);
        expect(renderAgentResume('codex', 'codex', SID)).toBe(`codex resume ${SID}`);
    });

    it('has a resume decision for every tui, none left undefined', () => {
        for (const id of agentTuis()) {
            const resume = TUI_REGISTRY[id].resume;
            expect(resume === null || typeof resume === 'object', id).toBe(true);
        }
    });
});
