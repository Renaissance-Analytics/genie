import { describe, it, expect } from 'vitest';
import { pluginRecipeToRecipe } from '../plugin';
import type { PluginRecipeView } from '../../genie';

const view: PluginRecipeView = {
    pluginId: 'com.example.deployer',
    pluginName: 'Deployer',
    namespace: 'deployer',
    launchId: 'deployer.deploy',
    recipe: {
        id: 'deploy',
        title: 'Deploy',
        steps: [
            { type: 'form', id: 't', title: 'T', fields: [{ key: 'h', label: 'Host', required: true }] },
            { type: 'choice', id: 'e', title: 'E', options: [{ value: 'p', label: 'Prod' }] },
            { type: 'terminal', id: 'r', title: 'R', command: 'echo', args: ['hi'], capture: 'out' },
            { type: 'browser', id: 'o', title: 'O', url: 'https://example.com/' },
        ],
    },
};

describe('pluginRecipeToRecipe', () => {
    it('reconstitutes a plugin recipe view into a runtime Recipe keyed by launchId', () => {
        const r = pluginRecipeToRecipe(view);
        expect(r.id).toBe('deployer.deploy');
        expect(r.title).toBe('Deploy');
        expect(r.steps.map((s) => s.type)).toEqual(['form', 'choice', 'terminal', 'browser']);
    });

    it('preserves terminal command/args/capture', () => {
        const term = pluginRecipeToRecipe(view).steps[2];
        expect(term.type).toBe('terminal');
        if (term.type === 'terminal') {
            expect(term.command).toBe('echo');
            expect(term.args).toEqual(['hi']);
            expect(term.capture).toBe('out');
        }
    });

    it('carries a browser URL through as a string', () => {
        const b = pluginRecipeToRecipe(view).steps[3];
        expect(b.type).toBe('browser');
        if (b.type === 'browser') expect(b.url).toBe('https://example.com/');
    });
});
