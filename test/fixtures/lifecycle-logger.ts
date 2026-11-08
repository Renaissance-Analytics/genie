/**
 * A HOST THAT LOGS (test/lifecycle-log-async.test.ts, Tynn #548): genie-host's lifecycle log, written off the thread.
 * `stream`: logs numbered lines in fast bursts until the test kills this process outright. `exit N`: logs N lines and
 * exits at once, nothing awaited. `throw N`: logs N lines, then an uncaught error ends it.
 */
import { openLifecycleLog } from '../../src/main/lifecycle-log.js';

const [dir, mode, count] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? 0)];
const log = openLifecycleLog(dir, { async: true } as never) as (line: string) => void;
if (mode === 'stream') {
    let n = 0;
    process.stdout.write('LOGGING\n');
    // Bursts of 20 lines every millisecond: far more than a host logs, and never a queue so long it must drop lines.
    const go = (): void => { for (let i = 0; i < 20; i += 1) { n += 1; log(`seq=${n} ${'x'.repeat(n % 97)}`); } setTimeout(go, 1); };
    go();
} else {
    for (let n = 1; n <= count; n += 1) log(`seq=${n} ${'y'.repeat(n % 53)}`);
    if (mode === 'exit') process.exit(0);
    throw new Error('the host fell over');
}
