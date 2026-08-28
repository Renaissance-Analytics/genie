import { describe, expect, it } from 'vitest';
import {
    TERMINAL_TYPES,
    DEFAULT_TERMINAL_TYPE,
    terminalTypeById,
    terminalTypeForAgent,
    agentTerminalTypes,
    panelLauncherTypes,
} from '../terminal-types';
import { workspaceSlug } from '../genie';
import { normalizePurpose } from '../../components/Master/AgentTerminalForm';
import { agentProviders, providerDef } from '../../../main/agents/registry';

/**
 * The split Add-Terminal button + the AgentInbox create form read from these
 * pure helpers, so lock in the registry shape, the last-used fallback, the
 * channel-slug fallback resolution, and the purpose kebab/word-cap.
 */

describe('terminal-type registry', () => {
    it('leads with a single non-specialized "regular" type, then the agents', () => {
        expect(TERMINAL_TYPES[0].id).toBe('regular');
        expect(TERMINAL_TYPES[0].specialized).toBe(false);
        expect(TERMINAL_TYPES[0].agent).toBeUndefined();
        const specialized = TERMINAL_TYPES.filter((t) => t.specialized);
        expect(specialized.map((t) => t.agent)).toEqual(['claude', 'codex', 'kiwi', 'genie', 'custom']);
        // Every specialized type carries an agent kind; regular never does.
        for (const t of specialized) expect(t.agent).toBeTruthy();
    });

    /**
     * The catalogue is DERIVED from PROVIDER_REGISTRY (genie#261), so a provider
     * added to the registry appears in the Add-Terminal dropdown without an edit
     * here — and cannot be forgotten. Label and hint come from the registry too,
     * so the dropdown and the Settings rows cannot disagree.
     */
    it('carries exactly the registry providers, with the registry label and hint', () => {
        const specialized = TERMINAL_TYPES.filter((t) => t.specialized);
        expect(specialized.map((t) => t.agent)).toEqual(agentProviders());
        for (const t of specialized) {
            const def = providerDef(t.agent!);
            expect(t.label, `${t.agent} label`).toBe(def.label);
            expect(t.hint, `${t.agent} hint`).toBe(def.hint);
        }
    });

    it('gives every provider an icon', () => {
        for (const id of agentProviders()) {
            expect(terminalTypeForAgent(id).icon, `${id} icon`).toBeTruthy();
            expect(terminalTypeForAgent(id).id, `${id} resolves to itself`).toBe(id);
        }
    });

    it('has unique ids and a regular default', () => {
        const ids = TERMINAL_TYPES.map((t) => t.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(DEFAULT_TERMINAL_TYPE).toBe('regular');
    });

    it('terminalTypeById falls back to regular for unknown / missing', () => {
        expect(terminalTypeById('claude').id).toBe('claude');
        expect(terminalTypeById('nope').id).toBe('regular');
        expect(terminalTypeById(null).id).toBe('regular');
        expect(terminalTypeById(undefined).id).toBe('regular');
    });

    it('terminalTypeForAgent resolves each agent kind', () => {
        expect(terminalTypeForAgent('claude').id).toBe('claude');
        expect(terminalTypeForAgent('codex').id).toBe('codex');
        expect(terminalTypeForAgent('custom').id).toBe('custom');
    });

    it('offers only agent providers in the dedicated New Agent picker', () => {
        expect(agentTerminalTypes().map((type) => type.id)).toEqual(agentProviders());
        expect(agentTerminalTypes().every((type) => type.specialized && type.agent)).toBe(true);
    });

    it('keeps agents out of Add Panel because AgentBuilder owns agent creation', () => {
        expect(panelLauncherTypes().map((type) => type.id)).toEqual(['regular']);
    });
});

describe('workspaceSlug (channel-name fallback)', () => {
    it('strips a .agi envelope-folder suffix', () => {
        expect(workspaceSlug({ path: '/home/me/tynn.agi', project_name: 'Tynn' })).toBe('tynn');
    });
    it('kebabs the folder leaf, backslashes or forward slashes', () => {
        expect(workspaceSlug({ path: 'C:\\proj\\My App', project_name: 'x' })).toBe('my-app');
    });
    it('falls back to the project name when there is no path', () => {
        expect(workspaceSlug({ path: '', project_name: 'Cool Project!' })).toBe('cool-project');
    });
    it('never yields an empty slug', () => {
        expect(workspaceSlug({ path: '', project_name: '' })).toBe('workspace');
    });
});

describe('normalizePurpose (kebab + word cap)', () => {
    it('kebabs and lowercases', () => {
        expect(normalizePurpose('Build The Thing')).toBe('build-the-thing');
    });
    it('defaults an empty purpose to general', () => {
        expect(normalizePurpose('')).toBe('general');
        expect(normalizePurpose('   ')).toBe('general');
    });
    it('strips trailing/leading separators', () => {
        expect(normalizePurpose('--front-end--')).toBe('front-end');
    });
});
