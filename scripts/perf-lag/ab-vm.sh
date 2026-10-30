#!/usr/bin/env bash
# SAME-SESSION A/B/C ON A TEST VM (genie#1340). A test VM's speed varies about 2x between sessions, so a before/after is
# only read from builds alternated within ONE session. From the envelope, with the patch made on the desktop first:
#
#   git diff origin/main..HEAD -- src package.json package-lock.json > perf-fix.patch      (in the worktree; not committed)
#   scripts/vm-fifo.sh omarchy <worktree> 'bash scripts/perf-lag/ab-vm.sh'
#
#   base  = this tree with the fix reversed (perf-fix.patch: src + package files) = main, react-fancy 5.70.0
#   fix70 = this tree with react-fancy 5.70.0 (the Genie fix alone)
#   fix   = this tree (the Genie fix + react-fancy 5.71.1)
set -u
mkdir -p perf-out
# The tree is shipped from a Windows checkout (CRLF); the patch is LF.
rm -rf ../ab-base ../ab-fix70 && cp -a . ../ab-base && cp -a . ../ab-fix70 && (cd ../ab-base && find src package.json package-lock.json -type f -exec sed -i 's/\r$//' {} + && patch -R -p1 < perf-fix.patch) || { echo "reverse patch failed"; exit 1; }
for t in ../ab-base ../ab-fix70 .; do (cd "$t" && mkdir -p perf-out && npm ci --no-audit --no-fund >perf-out/ci.log 2>&1) || { echo "ci failed in $t"; tail -20 "$t/perf-out/ci.log"; exit 1; }; done
(cd ../ab-fix70 && npm install --no-save --no-audit --no-fund @particle-academy/react-fancy@5.70.0 >perf-out/ci2.log 2>&1) || { echo "fix70 install failed"; exit 1; }
for t in ../ab-base ../ab-fix70 .; do (cd "$t" && echo "$t react-fancy $(node -p "require('@particle-academy/react-fancy/package.json').version")" && npm run build >perf-out/build.log 2>&1) || { echo "build failed in $t"; tail -20 "$t/perf-out/build.log"; exit 1; }; done
for i in 1 2; do
    (cd ../ab-base && SKIP_BUILD=1 bash scripts/perf-lag/run-vm.sh "base$i:base:1:240")
    (cd ../ab-fix70 && SKIP_BUILD=1 bash scripts/perf-lag/run-vm.sh "fixold$i:base:1:240")
    SKIP_BUILD=1 bash scripts/perf-lag/run-vm.sh "fix$i:base:1:240"
done
cp ../ab-base/perf-out/base* ../ab-fix70/perf-out/fixold* perf-out/
for d in base fixold fix; do mkdir -p "perf-out/dist-$d/renderer/assets"; done
cp ../ab-base/dist/renderer/assets/*.map perf-out/dist-base/renderer/assets/; cp ../ab-fix70/dist/renderer/assets/*.map perf-out/dist-fixold/renderer/assets/; cp dist/renderer/assets/*.map perf-out/dist-fix/renderer/assets/
for f in perf-out/*-result.json; do node -e "const r=require('./$f'); console.log(r.label.padEnd(7), 'steady', JSON.stringify(r.steady.keys), JSON.stringify(r.steady.phases), 'frame', JSON.stringify(r.steady.frameMs), 'rLong', r.steady.rendererLong.totalMs, 'mainLag', r.steady.mainLag.totalMs)"; done
