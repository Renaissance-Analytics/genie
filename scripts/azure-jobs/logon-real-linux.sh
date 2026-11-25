#az os=linux size=Standard_D4ads_v5 fetch=ci-out timeout=3000 windows=0
# A REAL LOGON ON LINUX (Tynn #1036 P6-3, task #1501), for the envelope's queue: bash scripts/azure/q.sh submit <tree> <this file>.
# Not a gate row: it ends the graphical session twice (scripts/vm-logon-linux.sh real). windows=0: the compositor gives no
# frames while SDDM brings the new session up, which is the point, not a broken VM. A break probe: write logon-break.txt
# (no-entry or stale-entry) at the top of a copy of this file.
bash scripts/ci/linux.sh --only package || exit 1
bash scripts/vm-logon-linux.sh real
