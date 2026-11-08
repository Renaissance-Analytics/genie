/**
 * A HOST THAT BEATS AS FAST AS IT CAN (test/safe-mode-async-beat.test.ts, Tynn #538): genie-host's SafeMode with its beat
 * written off the thread, beaten without pause with a growing agent list, until the test kills this process outright,
 * mid-write as often as not.
 */
import { SafeMode } from '../../src/main/safe-mode-host.js';

const dir = process.argv[2]!;
const mode = SafeMode.open(dir, { asyncBeat: true });
let n = 0;
process.stdout.write('BEATING\n');
const go = (): void => { n += 1; mode.beat(Array.from({ length: (n % 7) + 1 }, (_, i) => `agent_${n}_${i}`)); setImmediate(go); };
go();
