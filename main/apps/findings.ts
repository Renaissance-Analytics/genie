/**
 * PURE. What a Genie App check SAYS, and how it reads (genie#245 follow-on).
 *
 * The GApp checks are the easy half. The half that decides whether any of this is
 * worth shipping is the OUTPUT, so the shape of an answer lives in its own module
 * and is tested like any other thing people depend on.
 *
 * ## Why a finding has three fields and not one string
 *
 * The failure this whole suite exists to prevent is genie#245: a developer followed
 * the SDK README, shipped personas, installed, and got empty terminals with no
 * error. Nothing told them anything was wrong. A checker that answers that with
 * `expected true, got false` — or even with "invalid manifest" — has reproduced the
 * original failure with an extra step.
 *
 * So every finding must answer three questions, and the type is what forces it:
 *
 *   where    the file, path or manifest pointer they should open
 *   problem  what is wrong with it, in a sentence somebody who has never read
 *            Genie's source can understand
 *   fix      what to DO — an instruction, not a diagnosis
 *
 * ## Errors and advice stay apart
 *
 * The split already exists in `validateAppFolder` and it is kept here for its
 * stated reason: an ERROR means the app will not work, ADVICE means it will work
 * and the developer should think about it. Merging them trains people to skim both,
 * and the one that gets skimmed is always the one that mattered.
 */

/** How much a finding matters. Two levels, deliberately — three is a spectrum nobody reads. */
export type CheckSeverity = 'error' | 'advice';

export interface AppFinding {
    /**
     * Stable id, e.g. `agents.persona-missing`.
     *
     * It is what a test asserts on, what a CLI can filter by, and what a developer
     * can search for. Message wording is allowed to improve; this is not.
     */
    check: string;
    severity: CheckSeverity;
    /** The file, path on disk, or manifest pointer to open. */
    where: string;
    /** What is wrong. */
    problem: string;
    /** What to do about it. */
    fix: string;
}

/**
 * A finding as ONE line — problem and fix together.
 *
 * This is what the legacy `errors: string[]` / `advice: string[]` lists are built
 * from, so every existing caller that joins those strings keeps saying what to do
 * rather than only what is broken.
 */
export function findingLine(finding: AppFinding): string {
    return `${finding.problem} ${finding.fix}`.trim();
}

export interface CheckReportLike {
    ok: boolean;
    findings: AppFinding[];
    /** The check ids that were evaluated — so the report can say what it covered. */
    ran: string[];
    app?: { name: string; version: string };
}

/** Terminal-friendly width. Wide enough for paths, narrow enough to read. */
const WIDTH = 92;

function wrap(text: string, indent: string): string[] {
    const out: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
        // A word longer than the budget (a Windows path, a URL) goes on its own
        // line rather than being broken — a path split across two lines cannot be
        // copied, which is the only thing anyone wants to do with it.
        if (line && `${line} ${word}`.length + indent.length > WIDTH) {
            out.push(indent + line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) out.push(indent + line);
    return out;
}

function block(finding: AppFinding): string[] {
    return [
        `  [${finding.check}]  ${finding.where}`,
        ...wrap(finding.problem, '    '),
        // The arrow is load-bearing: it is how the eye finds the instruction
        // without reading the diagnosis again.
        ...wrap(`→ ${finding.fix}`, '    '),
        '',
    ];
}

/**
 * The whole report, as plain text.
 *
 * Used by the CLI and by anything else that has to put this in front of a person
 * without a UI to render it. The renderer draws its own, from the same findings.
 */
export function formatCheckReport(report: CheckReportLike, folder: string): string {
    const errors = report.findings.filter((f) => f.severity === 'error');
    const advice = report.findings.filter((f) => f.severity === 'advice');

    const lines: string[] = [
        report.app ? `${report.app.name} ${report.app.version} — ${folder}` : folder,
        `${report.ran.length} checks ran.`,
        '',
    ];

    if (errors.length > 0) {
        lines.push(
            `ERRORS — ${errors.length === 1 ? 'this' : 'these'} must be fixed before the app will work`,
            '',
        );
        for (const finding of errors) lines.push(...block(finding));
    } else {
        lines.push('No errors — this folder is ready to install.', '');
    }

    if (advice.length > 0) {
        // Kept below the errors and under its own heading. It stays visible on a
        // PASSING check: it is the half a developer would otherwise never see.
        lines.push('WORTH A SECOND THOUGHT — it will work, but', '');
        for (const finding of advice) lines.push(...block(finding));
    }

    return lines.join('\n');
}
