import { describe, expect, it } from 'vitest';
import { popFilePanel } from '../workspace-file-panel';

describe('moving the editor without losing its tabs', () => {
    it('awaits persisted tab state before opening the window', async () => {
        const events: string[] = [];
        let finish: () => void = () => {};
        const saved = new Promise<void>((resolve) => { finish = resolve; });
        const pending = popFilePanel({
            persist: () => { events.push('persist'); return saved; },
            pop: async () => { events.push('pop'); },
        });
        expect(events).toEqual(['persist']);
        finish();
        await pending;
        expect(events).toEqual(['persist', 'pop']);
    });

    it('does not open a window when persisting tabs fails', async () => {
        let opened = false;
        await expect(popFilePanel({ persist: async () => { throw new Error('save failed'); }, pop: async () => { opened = true; } })).rejects.toThrow('save failed');
        expect(opened).toBe(false);
    });
});
