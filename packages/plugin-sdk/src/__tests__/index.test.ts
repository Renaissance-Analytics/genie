import { describe, expect, it } from 'vitest';
import { definePlugin } from '../index';

describe('@genie/plugin-sdk', () => {
    it('preserves a typed Fancy panel contribution', () => {
        const plugin = definePlugin({
            id: 'com.example.board', namespace: 'board', name: 'Board', version: '1.0.0',
            contributes: { panels: [{
                id: 'main', title: 'Board',
                fancyComponent: { package: '@example/fancy-board', version: '^1.0.0', export: 'Board' },
            }] },
            capabilities: { genieApi: ['ui.panel'] },
        });
        expect(plugin.contributes?.panels?.[0].fancyComponent.export).toBe('Board');
    });
});
