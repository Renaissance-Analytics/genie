/**
 * Which Genie this launch is (the owner, 2026-10-12): `--doctor` opens doctor mode — the Genie OSA alone, Genie's
 * configuration and database never opened (main/doctor.ts). Anything else is Genie.
 */
export function entryFor(argv: readonly string[]): 'doctor' | 'main' {
    return argv.includes('--doctor') ? 'doctor' : 'main';
}
