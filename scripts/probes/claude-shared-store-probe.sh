#!/usr/bin/env bash
# MEASUREMENT (Tynn #1011): can a Claude thread started under account A resume under account B, when each account is its own
# CLAUDE_CONFIG_DIR and both dirs' `projects` is a link to ONE shared session store? Undocumented CLI behaviour, so measured
# against the real CLI, on a test VM only, never the owner's desktop.
#
# No real credential exists here. Each account dir carries an `apiKeyHelper` that prints a FAKE key of its own, and the CLI is
# pointed at a local stand-in for the Messages API (anthropic-mock.mjs), which records the key and the history of every
# request. So "B's credentials are used" reads as: every request of B's run carried B's key and none carried A's.
#
#   bash scripts/probes/claude-shared-store-probe.sh <out-dir> [claude-code-version]
#
# Checks (each PASS/FAIL line goes to <out-dir>/verdict.txt):
#   1 A's run writes its transcript into the shared store, through A's link
#   2 B resumes A's thread: B's request carries A's canary (history intact)
#   3 B's run sends B's key only; A's run sent A's key only (positive control for the gauge)
#   4 B's run opens NOTHING under A's dir (strace), while it does open under B's (positive control)
#   5 control: a dir WITHOUT the link cannot resume the thread (proves the link is what carries it)
set -uo pipefail
OUT=${1:?usage: claude-shared-store-probe.sh <out-dir> [version]}
VERSION=${2:-2.1.330}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
: > "$OUT/verdict.txt"
verdict() { echo "$1" | tee -a "$OUT/verdict.txt"; }

echo "== install Claude Code $VERSION"
npm install --prefix /tmp/probe-cc --no-audit --no-fund "@anthropic-ai/claude-code@$VERSION" > "$OUT/install.log" 2>&1
CLAUDE=/tmp/probe-cc/node_modules/.bin/claude
"$CLAUDE" --version | tee "$OUT/version.txt" || { verdict "FAIL install: claude did not run"; exit 0; }
command -v strace >/dev/null || sudo pacman -Sy --noconfirm --needed strace > "$OUT/strace-install.log" 2>&1 || sudo apt-get install -y strace >> "$OUT/strace-install.log" 2>&1
command -v strace >/dev/null && HAVE_STRACE=1 || HAVE_STRACE=0

ROOT=/tmp/probe-accounts
SHARED="$HOME/.claude/projects"        # the default account's store: the one every account shares
A="$ROOT/a"; B="$ROOT/b"; C="$ROOT/c-unlinked"
WORK=/tmp/probe-work
rm -rf "$ROOT" "$WORK"; mkdir -p "$SHARED" "$A" "$B" "$C/projects" "$WORK"
ln -s "$SHARED" "$A/projects"
ln -s "$SHARED" "$B/projects"
printf '{"apiKeyHelper":"echo sk-ant-probe-account-A"}\n' > "$A/settings.json"
printf '{"apiKeyHelper":"echo sk-ant-probe-account-B"}\n' > "$B/settings.json"
printf '{"apiKeyHelper":"echo sk-ant-probe-account-C"}\n' > "$C/settings.json"

: > "$OUT/requests.jsonl"
node "$HERE/anthropic-mock.mjs" "$OUT/requests.jsonl" "$OUT/port" & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
for _ in $(seq 50); do [ -s "$OUT/port" ] && break; sleep 0.1; done
PORT=$(cat "$OUT/port")
phase() { curl -fsS "http://127.0.0.1:$PORT/__phase?name=$1" >/dev/null; }

# Only what the CLI needs; every inherited Anthropic variable is dropped so the dir's helper is the one credential.
run_claude() {  # <config-dir> <strace-file|-> <args...>
    local dir=$1 trace=$2; shift 2
    local envs=(env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN
        CLAUDE_CONFIG_DIR="$dir" ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT"
        DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_ERROR_REPORTING=1)
    if [ "$trace" != - ] && [ "$HAVE_STRACE" = 1 ]; then
        (cd "$WORK" && strace -f -qq -e trace=%file -o "$trace" "${envs[@]}" "$CLAUDE" "$@")
    else
        (cd "$WORK" && "${envs[@]}" "$CLAUDE" "$@")
    fi
}

CANARY="CANARY_$(date +%s)_$RANDOM"
echo "== A starts a thread"
phase a
run_claude "$A" "$OUT/a.strace" -p "Remember this word: $CANARY" --output-format json --model claude-sonnet-4-5 > "$OUT/a.json" 2> "$OUT/a.err"; echo "a exit $?" | tee "$OUT/a.exit"
ID=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.session_id??"")}catch{console.log("")}' "$OUT/a.json")
echo "session: ${ID:-none}" | tee "$OUT/session.txt"
[ -n "$ID" ] || { verdict "FAIL 1 A's run reported no session id"; cat "$OUT/a.err"; exit 0; }

TRANSCRIPT=$(find "$SHARED" -name "$ID.jsonl" 2>/dev/null | head -1)
if [ -n "$TRANSCRIPT" ] && [ -L "$A/projects" ]; then verdict "PASS 1 transcript in the shared store via A's link: ${TRANSCRIPT#$HOME/}"; else verdict "FAIL 1 no transcript $ID.jsonl under $SHARED"; fi

echo "== B resumes it"
phase b
run_claude "$B" "$OUT/b.strace" -p --resume "$ID" "What was the word I asked you to remember?" --output-format json --model claude-sonnet-4-5 > "$OUT/b.json" 2> "$OUT/b.err"; echo "b exit $?" | tee "$OUT/b.exit"

echo "== control: an unlinked dir resumes it"
phase c
run_claude "$C" - -p --resume "$ID" "What was the word?" --output-format json --model claude-sonnet-4-5 > "$OUT/c.json" 2> "$OUT/c.err"; echo "c exit $?" | tee "$OUT/c.exit"
phase done

node - "$OUT/requests.jsonl" "$CANARY" >> "$OUT/verdict.txt" <<'NODE'
const [file, canary] = process.argv.slice(2);
const rows = require('fs').readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const msgs = (p) => rows.filter((r) => r.phase === p && r.method === 'POST' && r.path.startsWith('/v1/messages') && !r.path.endsWith('count_tokens'));
const keyOf = (r) => r.apiKey ?? (r.authorization ?? '').replace(/^Bearer /, '');
const keys = (p) => [...new Set(msgs(p).map(keyOf))];
const a = msgs('a'), b = msgs('b'), c = msgs('c');
console.log(`INFO requests: a=${a.length} b=${b.length} c=${c.length}; keys a=${JSON.stringify(keys('a'))} b=${JSON.stringify(keys('b'))} c=${JSON.stringify(keys('c'))}`);
const bHist = b.some((r) => r.body.includes(canary));
console.log(`${b.length > 0 && bHist ? 'PASS' : 'FAIL'} 2 B's request carries A's canary (history intact): ${bHist}`);
const aOnlyA = a.length > 0 && keys('a').every((k) => k === 'sk-ant-probe-account-A');
const bOnlyB = b.length > 0 && keys('b').every((k) => k === 'sk-ant-probe-account-B');
console.log(`${aOnlyA && bOnlyB ? 'PASS' : 'FAIL'} 3 keys: A's run only A's (${aOnlyA}), B's run only B's (${bOnlyB})`);
const cHist = c.some((r) => r.body.includes(canary));
console.log(`${!cHist ? 'PASS' : 'FAIL'} 5 control: the unlinked dir did not get the thread (canary sent: ${cHist})`);
NODE

if [ "$HAVE_STRACE" = 1 ]; then
    inA_b=$(grep -c "$A" "$OUT/b.strace" || true); inB_b=$(grep -c "$B" "$OUT/b.strace" || true); inA_a=$(grep -c "$A" "$OUT/a.strace" || true)
    # The positive controls: the same grep finds A's dir in A's run and B's dir in B's run.
    if [ "$inA_a" -gt 0 ] && [ "$inB_b" -gt 0 ] && [ "$inA_b" -eq 0 ]; then st=PASS; else st=FAIL; fi
    verdict "$st 4 B's run opened nothing under A's dir: $inA_b paths (controls: A's dir in A's run $inA_a, B's dir in B's run $inB_b)"
    # Every path B's run named in a file call, de-duplicated (for prism-acp's shared-store helper); and what it touched in the
    # default home OUTSIDE the shared store (the default account's own files must not be among them).
    grep -o '"/[^"]*"' "$OUT/b.strace" | tr -d '"' | sort | uniq -c | sort -k2 > "$OUT/b-all-paths.txt" || true
    grep -o '"/[^"]*"' "$OUT/b.strace" | tr -d '"' | grep -F "$HOME/.claude" | grep -v -F "$SHARED" | sort -u > "$OUT/b-default-home-outside-store.txt" || true
    n=$(wc -l < "$OUT/b-default-home-outside-store.txt")
    verdict "INFO 4b B's run touched $n paths in the default home outside the shared store (b-default-home-outside-store.txt)"
else
    verdict "UNMEASURED 4 strace not available"
fi
echo "== what each dir holds after the runs (names only, no file read)"
for d in "$A" "$B" "$C"; do echo "$d:"; ls -la "$d"; done > "$OUT/dir-listing.txt" 2>&1
cat "$OUT/dir-listing.txt"
echo "== verdict"; cat "$OUT/verdict.txt"
