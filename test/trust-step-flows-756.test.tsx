import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TrustStepBody } from '../src/renderer/components/TrustStep.js';
import type { TrustStepView } from '../src/renderer/features.js';

/**
 * THE TRUST STEP SHOWS WHAT A CLONE WOULD RUN (Tynn #756, PR9b): the flows and processes its files carry, with their commands,
 * before anything is created; and it says what they become after the yes: flows disarmed, processes stopped, nothing running
 * until the person starts it. Fixtures are invented names.
 */

const EMPTY = { sites: [], hooks: [], servers: [], gitKeys: [], approvals: [] };
const step = (list: Partial<TrustStepView['list']> = {}): TrustStepView => ({ workspaceId: 'acme', changed: false, list: { ...EMPTY, ...list } });
const body = (view: TrustStepView) => renderToStaticMarkup(<TrustStepBody step={view} phase={{ kind: 'idle' }} onTrust={() => {}} />);

describe('the flows and processes', () => {
    it('are listed with the file and every command it would run', () => {
        const html = body(step({
            flows: [{ file: '.flows/nightly.json', commands: ['npm run backup', 'ask lift@acme: Check the queue.'] }],
            processes: [{ file: '.processes/worker.json', commands: ['php artisan queue:work'] }],
        }));
        for (const words of ['.flows/nightly.json', 'npm run backup', 'ask lift@acme: Check the queue.', '.processes/worker.json', 'php artisan queue:work']) expect(html).toContain(words);
        expect(html).toMatch(/data-trust-group="Flows"/);
        expect(html).toMatch(/data-trust-group="Processes"/);
    });

    it('say what they become after the yes: flows disarmed, processes stopped, nothing running until the person starts it', () => {
        const html = body(step({ flows: [{ file: '.flows/nightly.json', commands: ['npm run backup'] }] }));
        expect(html).toMatch(/data-trust-clone-note/);
        expect(html).toMatch(/disarmed/);
        expect(html).toMatch(/stopped/);
    });

    it('a workspace whose only files to run are flows is not "nothing listed"', () => {
        const html = body(step({ processes: [{ file: '.processes/worker.json', commands: ['x'] }] }));
        expect(html).not.toMatch(/data-trust-nothing-listed/);
    });

    it('CONTROL: with no flows or processes there is no such note, and the yes is still there', () => {
        const html = body(step());
        expect(html).not.toMatch(/data-trust-clone-note/);
        expect(html).toMatch(/data-action="trust-workspace"/);
    });
});
