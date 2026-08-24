/**
 * The process shell for `npm run check:gapp -- <folder>`.
 *
 * Nothing but wiring, and it is a file of its own for one reason: an "am I the
 * entry point?" guard cannot be written portably here. Under `vite-node`,
 * `process.argv[1]` is vite-node's own launcher rather than this script, so the
 * usual check silently never fires — which is exactly how a CLI comes to print
 * nothing and exit 0 on a broken app.
 *
 * With the side effect in its own module there is nothing to guard: the decisions
 * live in `check-cli.ts`, which the tests import without running anything.
 */

import path from 'path';
import { fsCheckProbe } from './check-fs';
import { checkApp } from './checkup';
import { runGappCheck } from './check-cli';

process.exitCode = runGappCheck(process.argv.slice(2), {
    cwd: () => process.cwd(),
    check: (folder) =>
        checkApp(
            path.resolve(folder),
            // A CLI has no business opening Genie's database, so it does not
            // pretend to know whether another installed app already holds this
            // address. Genie's own check answers that one; this says nothing rather
            // than guessing.
            fsCheckProbe({ slugTaken: () => false }),
        ),
    write: (text) => process.stdout.write(text),
});
