import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * THE SAMPLER'S SUMMARY NAMES A HOT SVCHOST BY ITS SERVICES, AND THE BUSIEST PROCESSES BY BYTES (scripts/ci/proc-sampler.ps1,
 * proc-sampler-summary.mjs; #1636's run had svchost#1468 hot for ~90 s beside a knowledge.db EBUSY, and no name for it).
 * The summary reads the lines the sampler writes, old and new, and prints the window around each failing file.
 */
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function summary(lines: string[], failing: { name: string; start: string; end: string }[]) {
    dir = mkdtempSync(join(tmpdir(), 'sampler-summary-'));
    const samples = join(dir, 'proc-samples.log');
    const results = join(dir, 'vitest.json');
    writeFileSync(samples, `${lines.join('\n')}\n`);
    writeFileSync(results, JSON.stringify({ testResults: failing.map((f) => ({ name: `D:\\a\\genie\\genie\\test\\${f.name}`, status: 'failed', startTime: Date.parse(f.start), endTime: Date.parse(f.end) })) }));
    return execFileSync(process.execPath, ['scripts/ci/proc-sampler-summary.mjs', samples, results], { encoding: 'utf8' });
}

describe('the sampler summary', () => {
    it('names the services in a hot svchost, and the processes moving the most bytes, beside the failing file', () => {
        const out = summary([
            '2026-11-06T21:10:00Z disk_q=12 cpu>=1s: svchost#1468[WSearch]=1.8s node#77=1.2s io: MsMpEng=40.5MB/s node=3.1MB/s',
            '2026-11-06T21:10:05Z disk_q=9 cpu>=1s: svchost#1468[WSearch]=1.6s io: MsMpEng=22MB/s',
            '2026-11-06T21:30:00Z disk_q=0 cpu>=1s: node#77=1.1s io: ',
        ], [{ name: 'feature-ipc-knowledge.test.ts', start: '2026-11-06T21:10:02Z', end: '2026-11-06T21:10:07Z' }]);
        expect(out).toContain('test/feature-ipc-knowledge.test.ts');
        expect(out).toMatch(/21:10:00 disk_q=12 svchost\[WSearch\]#1468=1\.8s node#77=1\.2s io: MsMpEng=40\.5MB\/s node=3\.1MB\/s/);
        expect(out).toMatch(/21:10:05 disk_q=9 svchost\[WSearch\]#1468=1\.6s io: MsMpEng=22MB\/s/);
        // CONTROL: a sample outside the window is not printed beside it.
        expect(out).not.toContain('21:30:00');
    });

    it('still reads the older lines (no services, no io part)', () => {
        const out = summary(['2026-11-06T21:10:00Z disk_q=3 cpu>=1s: svchost#1468=1.8s'], [{ name: 'x.test.ts', start: '2026-11-06T21:10:00Z', end: '2026-11-06T21:10:01Z' }]);
        expect(out).toMatch(/21:10:00 disk_q=3 svchost#1468=1\.8s/);
    });
});
