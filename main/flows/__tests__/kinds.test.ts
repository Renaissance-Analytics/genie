import { describe, expect, it } from 'vitest';
import { getNodeKind, listNodeKinds, validateConfig } from '@particle-academy/fancy-flow/engine';
import { CORE_TOOLS } from '../../mcp/protocol';
import { APP_CAPABILITIES, UNGRANTABLE_TOOLS } from '../../apps/capabilities';
import { GENIE_NODE_NAMESPACE, isGenieNodeKind, nodeKindForTool, toolForNodeKind } from '../nodes';
import { genieNodeDefinitions, registerGenieKinds } from '../kinds';
import { newFlowNode } from '../graph';

/**
 * Genie's own steps, as things an author can drop on a canvas.
 *
 * ## Why any of this exists
 *
 * `nodes.ts` has always derived a node kind per Genie tool from the capability
 * catalogue. Nothing ever REGISTERED them, and nothing in the renderer ever
 * asked for them — so the palette a person saw was fancy-flow's 27 builtins,
 * every one of which Genie's executor is designed to refuse. The canvas could
 * author only steps Genie would not run, and could not author the steps it
 * would. These tests are the standing answer to that.
 *
 * ## The property worth protecting
 *
 * The palette is DERIVED. `capabilities.ts` already fails the build when a Genie
 * tool is added without being classified; deriving the kinds from it extends
 * that to flows for free, and `UNGRANTABLE_TOOLS` produce no kind AT ALL —
 * unreachable by construction rather than by a check somebody has to remember.
 */

describe('the Genie namespace', () => {
    it('writes kinds under @genie/, the way every other node kind is namespaced', () => {
        expect(nodeKindForTool('manageSite')).toBe('@genie/manageSite');
        expect(GENIE_NODE_NAMESPACE).toBe('@genie/');
    });

    it('still reads the legacy `genie.` spelling a stored graph may carry', () => {
        // A stored graph outlives the spelling it was written with, and a flow
        // that silently stopped resolving would look like a permissions problem.
        expect(toolForNodeKind('genie.manageSite')).toBe('manageSite');
        expect(toolForNodeKind('@genie/manageSite')).toBe('manageSite');
        expect(isGenieNodeKind('genie.manageSite')).toBe(true);
        expect(isGenieNodeKind('@genie/manageSite')).toBe(true);
    });

    it('does not claim a kind that merely looks like one', () => {
        expect(toolForNodeKind('@genie/notATool')).toBeNull();
        expect(toolForNodeKind('@particle-academy/branch')).toBeNull();
        expect(isGenieNodeKind('@particle-academy/branch')).toBe(false);
    });

    it('gives an ungrantable tool no kind at all', () => {
        for (const tool of Object.keys(UNGRANTABLE_TOOLS)) {
            expect(toolForNodeKind(`@genie/${tool}`)).toBeNull();
            expect(toolForNodeKind(`genie.${tool}`)).toBeNull();
        }
    });
});

describe('the definitions Genie registers', () => {
    const defs = genieNodeDefinitions();

    it('covers every classified tool, and only those', () => {
        const classified = APP_CAPABILITIES.flatMap((c) => c.tools);
        expect(defs.map((d) => d.tool).sort()).toEqual([...classified].sort());
    });

    it('names a config field for every property its tool accepts', () => {
        // The failure this prevents: a node whose panel cannot express the call,
        // so the step is authorable and useless.
        for (const def of defs) {
            const tool = (CORE_TOOLS as { name: string; inputSchema?: { properties?: Record<string, unknown> } }[])
                .find((t) => t.name === def.tool);
            const props = Object.keys(tool?.inputSchema?.properties ?? {}).filter(
                (k) => k !== 'terminalId',
            );
            const fields = new Set(def.configSchema.map((f) => f.key));
            for (const prop of props) {
                expect(fields.has(prop), `${def.tool} has no field for "${prop}"`).toBe(true);
            }
        }
    });

    it('never offers a terminal id — a flow has no terminal to name', () => {
        for (const def of defs) {
            expect(def.configSchema.some((f) => f.key === 'terminalId')).toBe(false);
        }
    });

    it('is serializable, because the renderer registers the same objects', () => {
        // A React `icon` or a `renderBody` would cross IPC as `{}` and the
        // renderer would register a kind subtly unlike main's.
        expect(() => structuredClone(defs)).not.toThrow();
    });

    it('declares a side-effect class, so a retry cannot double-write blind', () => {
        for (const def of defs) {
            expect(['none', 'idempotent', 'unsafe-to-replay']).toContain(def.sideEffects);
        }
    });
});

describe('once registered', () => {
    registerGenieKinds();

    it('puts every Genie step in the live registry', () => {
        for (const def of genieNodeDefinitions()) {
            expect(getNodeKind(def.name)?.name, `${def.name} is not registered`).toBe(def.name);
        }
    });

    it('resolves the legacy spelling through the registry, not by string surgery', () => {
        expect(getNodeKind('genie.manageSite')?.name).toBe('@genie/manageSite');
    });

    it('lets `newFlowNode` build a Genie step, so templates and agents can author one', () => {
        const node = newFlowNode('@genie/manageSite');

        expect(node?.type).toBe('@genie/manageSite');
        expect(node?.data.kind).toBe('@genie/manageSite');
        // `defaultConfigFor` fills the defaults the panel would show.
        expect(node?.data.config).toBeTypeOf('object');
    });

    it('accepts a config the tool would accept', () => {
        const kind = getNodeKind('@genie/manageSite')!;
        expect(validateConfig(kind, { action: 'list' })).toEqual([]);
    });

    it('registers exactly once, however many times it is called', () => {
        const before = listNodeKinds().length;
        registerGenieKinds();
        expect(listNodeKinds().length).toBe(before);
    });
});
