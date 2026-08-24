/**
 * `npm run check:gapp -- <folder>` — the Genie App check, from a terminal.
 *
 * The Genie UI already has this (Settings → Genie Apps → “Check an app…”), and for
 * a person that is the right surface. This exists for the reader the UI cannot
 * serve: the AGENT building the app, and the CI job that has to refuse a broken
 * one. Neither can click a folder picker, and both can read an exit code.
 *
 * It runs the SAME `checkApp` over the SAME filesystem probe as the button does —
 * the point of a check is that its answer is the one Genie will act on, so a second
 * implementation for the terminal would be worse than no terminal at all.
 *
 * The decisions below are separated from the process so they can be tested: which
 * folder, what is printed, and the exit code — the only part a pipeline can see.
 */

import type { AppCheckReport } from './checkup';
import { formatCheckReport } from './findings';

export interface CheckCliIO {
    cwd: () => string;
    check: (folder: string) => AppCheckReport;
    write: (text: string) => void;
}

/** The exit code. 0 is "ship it"; anything else is a reason not to. */
export function runGappCheck(argv: readonly string[], io: CheckCliIO): number {
    const flags = new Set(argv.filter((a) => a.startsWith('--')));
    const folder = argv.find((a) => !a.startsWith('--')) ?? io.cwd();
    const report = io.check(folder);

    if (flags.has('--json')) {
        // Nothing else on stdout, ever: a stray banner is what turns "pipe it to
        // jq" into a bug report.
        io.write(
            `${JSON.stringify(
                {
                    ok: report.ok,
                    folder,
                    ...(report.app ? { app: report.app } : {}),
                    ran: report.ran,
                    findings: report.findings,
                },
                null,
                2,
            )}\n`,
        );
    } else {
        io.write(`${formatCheckReport(report, folder)}\n`);
    }

    if (!report.ok) return 1;
    // `--strict` is for a project that wants the advice bar too. Off by default,
    // because advice is a judgement call and a suite that fails on judgement calls
    // is one people start passing `--no-verify` to.
    if (flags.has('--strict') && report.findings.length > 0) return 1;
    return 0;
}
