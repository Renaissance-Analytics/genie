/**
 * Which Genie this launch is (the owner, 2026-10-12): `--doctor` opens doctor mode — the Genie OSA alone, Genie's
 * configuration and database never opened (main/doctor.ts). Anything else is Genie.
 */
export function entryFor(argv: readonly string[]): 'doctor' | 'browser' | 'updater' | 'main' {
    if (argv.includes('--genie-browser')) return 'browser';
    // The updater helper (the host split, P5b): started by genie-host to make electron-updater's calls, and nothing else.
    if (argv.includes('--updater')) return 'updater';
    return argv.includes('--doctor') ? 'doctor' : 'main';
}
