#!/usr/bin/env node
/**
 * A DATA ROOT ATTACHED TO A REBUILT MACHINE (the host split P7.3, Tynn #419): the row is scripts/rebuilt-machine-row.ts,
 * which reads Genie's own TypeScript (the engine client a window uses, the data root's lists). This runs it through tsx,
 * with this process's output and its exit code. Test machines only: the row itself refuses anywhere else.
 */
import { spawnSync } from 'node:child_process';

const ran = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), 'scripts/rebuilt-machine-row.ts', ...process.argv.slice(2)], { stdio: 'inherit' });
if (ran.error) { console.error(`### rebuilt-machine=FAIL  the row could not be started: ${ran.error.message}`); process.exit(1); }
process.exit(ran.status ?? 1);
