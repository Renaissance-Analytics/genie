import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/*
 * TRACKED RED ROWS, LINUX (Tynn #967). An acceptance row can land RED, before the stories that fix it, without
 * blocking every other PR's gate. It does that only for the reasons it names. linux.sh's TRACKED_RED table maps the row
 * to the reasons it may be red for, each with its story. The row prints one `TRACK <check> PASS|RED|BLOCKED <reason> ...`
 * line per check. The loop then reads:
 *   - `ROW <name> TRACKED <s> (known red: <reason> <story>, ...)` when the row failed, every RED reason is listed, and
 *     every listed reason is still RED or BLOCKED. It is not counted as failed.
 *   - FAIL for anything else: a RED reason that is not listed, a `TRACK ... FAIL` line, no TRACK lines, a timeout, a
 *     row an earlier need stopped, and (STRICT) a listed reason no check is red or blocked for any more. The PR that
 *     turns a reason green deletes its entry.
 *
 * This runs linux.sh's OWN loop (between `# >>> THE ROW LOOP` and `# <<< THE ROW LOOP`) with stub rows, as
 * test/ci-infra-rerun-linux.test.ts does.
 */

const root = join(__dirname, '..');
const source = readFileSync(join(root, 'scripts', 'ci', 'linux.sh'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('\n# >>> THE ROW LOOP');
const end = source.indexOf('\n# <<< THE ROW LOOP');
const loop = start > -1 && end > start ? source.slice(start + 1, end) : '';

/** Quiet samples: no stall, so nothing here is an INFRA rerun. */
function samples(): string {
    const now = Date.now();
    const lines = [];
    for (let t = now - 60000; t <= now + 120000; t += 2000) lines.push(`MACHINE ${t} gap=2000 cpu=4 steal=0 io_some=0 io_full=0 mem_full=0 load=0.4`);
    return lines.join('\n') + '\n';
}

function runLoop(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ci-tracked-linux-'));
    writeFileSync(join(dir, 'machine-samples.log'), samples());
    const script = `
set -uo pipefail
cd ${JSON.stringify(root)}
OUT=${JSON.stringify(dir)}; SETUP="$OUT/setup"; mkdir -p "$SETUP"
MACHINE_SAMPLES="$OUT/machine-samples.log"
failed=(); notes=(); infra=(); tracked=()
blocked=''; blocked_here=''; skip_reason=''
installed=''; electron_ok=''; built=''; built_why=''; display_ready=''; keyring_ready=''; app=''
ceiling() { case "$1" in slow) echo 1 ;; *) echo 60 ;; esac; }
watchdog() {
    local limit="$2" mark="$3" token="$4" s
    sleep "$limit" >/dev/null 2>&1 </dev/null &
    s=$!
    trap 'kill "$s" 2>/dev/null; exit 0' TERM
    wait "$s" || return 0
    printf '%s\\n' "$token" >"$mark"
}
machine_line() { :; }
reap_leftovers() { :; }
stop_app() { :; }
block() { blocked="$1"; blocked_here=1; echo "--- $1"; return 1; }
declare -A TRACKED_RED=(
    [known]="pacman:#968 elevation:#973 docker:#970"
    [stray]="pacman:#968"
    [explicit]="pacman:#968"
    [silent]="pacman:#968"
    [fixed]="pacman:#968 docker:#970"
    [allgreen]="pacman:#968"
    [notrun]="pacman:#968"
    [slow]="pacman:#968"
)
row_known() {
    echo "TRACK previews RED pacman every card says: no package manager found"
    echo "TRACK php-install RED pacman refused: no package manager found"
    echo "TRACK php-elevation BLOCKED elevation (not reached: the install was refused first)"
    echo "TRACK docker-daemon-off RED docker the card shows 29.9.2 and no Not running"
    echo "TRACK node-install PASS none Node 24.22.1 installed, the card says 24.22.1"
    return 1
}
row_stray() { echo "TRACK previews RED pacman no package manager found"; echo "TRACK app RED surprise the window never opened"; return 1; }
row_explicit() { echo "TRACK previews RED pacman no package manager found"; echo "TRACK app FAIL the page threw"; return 1; }
row_silent() { echo "it died before any check"; return 1; }
row_fixed() { echo "TRACK previews RED pacman no package manager found"; echo "TRACK docker-daemon-off PASS docker the card says Not running"; return 1; }
row_allgreen() { echo "TRACK previews PASS pacman no card says no package manager found"; return 0; }
row_notrun() { blocked='the build failed'; return 1; }
row_slow() { echo "TRACK previews RED pacman no package manager found"; sleep 5; return 1; }
row_plain() { echo "an untracked row's own failure"; return 1; }
row_ok() { return 0; }
${loop}
selected=(known stray explicit silent fixed allgreen notrun slow plain ok)
run_rows
infra_summary
tracked_summary
echo "FAILED: \${failed[*]}"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 90000 });
    return `${r.stdout}${r.stderr}`;
}

describe.skipIf(process.platform !== 'linux')('linux.sh: tracked red rows (#967)', () => {
    let out = '';
    beforeAll(() => { out = runLoop(); });

    it('has the loop between its markers, with the tracked verdict and its summary in it', () => {
        expect(loop).toMatch(/\nrun_rows\(\) \{/);
        expect(loop).toMatch(/\ntracked_verdict\(\) \{/);
        expect(loop).toMatch(/\ntracked_summary\(\) \{/);
    });
    it('a row red only for its listed reasons, with every listed reason still red or blocked, is TRACKED and not failed', () => {
        expect(out).toMatch(/^ROW known TRACKED \d+ \(known red: pacman #968, elevation #973 \(blocked\), docker #970\)$/m);
    });
    it('a RED reason that is not listed is a FAIL, naming it', () => {
        expect(out).toMatch(/^ROW stray FAIL \d+ \(tracked row red for an unlisted reason: surprise\)$/m);
    });
    it('a check that FAILed outright is a FAIL', () => {
        expect(out).toMatch(/^ROW explicit FAIL \d+ \(tracked row has a failed check: app\)$/m);
    });
    it('a tracked row that failed with no TRACK lines at all is a FAIL', () => {
        expect(out).toMatch(/^ROW silent FAIL \d+ \(tracked row failed with no TRACK line\)$/m);
    });
    it('STRICT: a listed reason that is no longer red or blocked is a FAIL that says to delete its entry', () => {
        expect(out).toMatch(/^ROW fixed FAIL \d+ \(listed red reasons no longer red: docker #970; delete them from TRACKED_RED\[fixed\]\)$/m);
    });
    it('STRICT: a tracked row that passes is a FAIL until its entry goes', () => {
        expect(out).toMatch(/^ROW allgreen FAIL \d+ \(listed red reasons no longer red: pacman #968; delete them from TRACKED_RED\[allgreen\]\)$/m);
    });
    it('a tracked row an earlier need stopped is still not run, a FAIL', () => {
        expect(out).toMatch(/^ROW notrun FAIL \d+ \(not run: the build failed\)$/m);
    });
    it('a tracked row that timed out is a FAIL, even with listed RED lines', () => {
        expect(out).toMatch(/^ROW slow FAIL \d+ \(timed out after 1 s\)$/m);
    });
    it('CONTROL: untracked rows are judged as before', () => {
        expect(out).toMatch(/^ROW plain FAIL \d+$/m);
        expect(out).toMatch(/^ROW ok PASS \d+$/m);
    });
    it('the summary names the tracked rows, and the run fails on every other failure', () => {
        expect(out).toMatch(/^TRACKED ROWS: known \(pacman #968, elevation #973 \(blocked\), docker #970\)$/m);
        expect(out).toMatch(/^FAILED: stray explicit silent fixed allgreen notrun slow plain$/m);
    });
});
