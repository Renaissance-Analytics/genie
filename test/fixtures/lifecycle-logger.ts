/**
 * A HOST THAT LOGS (test/lifecycle-log-async.test.ts, Tynn #548): genie-host's lifecycle log, written off the thread.
 * `stream`: logs numbered lines without pause until the test kills this process outright. `exit N`: logs N lines and
 * exits at once, nothing awaited. `throw N`: logs N lines, then an uncaught error ends it.
 */
import { openLifecycleLog } from '../../src/main/lifecycle-log.js';

const [dir, mode, count] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? 0)];
const log = openLifecycleLog(dir, { async: true } as never) as (line: string) => void;
if (mode === 'stream') {
    let n = 0;
    process.stdout.write('LOGGING\n');
    const go = (): void => { n += 1; log(`seq=${n} ${'x'.repeat(n % 97)}`); setImmediate(go); };
    go();
} else {
    for (let n = 1; n <= count; n += 1) log(`seq=${n} ${'y'.repeat(n % 53)}`);
    if (mode === 'exit') process.exit(0);
    throw new Error('the host fell over');
}
