import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The rule is driven in host-idle.test.ts; this holds that genie-host.ts asks it, with what the host itself holds. Comments stripped by line. */

const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

describe('genie-host.ts', () => {
    const host = () => strip('src/main/genie-host.ts');

    it('the idle exit asks hostIdleStep, with the armed flows and scheduled tasks from its own replicas', () => {
        const src = host();
        expect(src).toMatch(/hostIdleStep\(\{ agents: host\.count, windows: engine\.clients, ptys: relay\?\.live\(\) \?\? 0, \.\.\.onTheClock\(hostFlows\.list\(\), hostBook\.kept\(\)\) \}, lastBusy, Date\.now\(\), IDLE_MS\)/);
    });

    it('no second reading of the clock is left beside it', () => {
        expect(host()).not.toMatch(/Date\.now\(\) - lastBusy/);
    });
});
