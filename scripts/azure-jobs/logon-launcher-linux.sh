#az os=linux size=Standard_D4ads_v5 fetch=ci-out timeout=4200 windows=0
# LOGON-LAUNCHER (Tynn #1058 L5), for the queue: bash scripts/azure/q.sh submit <tree> <this file>. The launcher writes the
# autostart file and decides at logon; three NEW logons (SDDM and the user manager restarted: linux-job.sh has no reboot
# between stages), scripts/vm-logon-launcher-linux.sh real. windows=0: the compositor gives no frames while a session ends.
bash scripts/ci/linux.sh --only package-tracks || exit 1
bash scripts/vm-logon-launcher-linux.sh real
