/**
 * A host that starts the way genie-host.ts does: `close-inherited-fds` is its FIRST import (host-spawn-fds.test.ts). Says
 * it is up only after that module ran, then lives on.
 */
import '../../src/main/close-inherited-fds.js';
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.FD_TEST_READY!, String(process.pid));
setInterval(() => {}, 60_000);
