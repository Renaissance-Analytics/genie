/** A host that does NOT close what it inherited (host-spawn-fds.test.ts's control): says it is up, then lives on. */
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.FD_TEST_READY!, String(process.pid));
setInterval(() => {}, 60_000);
