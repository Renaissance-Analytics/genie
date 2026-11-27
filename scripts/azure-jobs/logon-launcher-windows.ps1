#az os=windows size=Standard_D4ads_v5 fetch=ci-out timeout=5400
# LOGON-LAUNCHER (Tynn #1058 L5), for the queue: bash scripts/azure/q.sh submit <tree> <this file>. The LAUNCHER writes the
# Run value and decides at logon. Four stages, the VM restarted between them and genie logged on again (run-job.sh #REBOOT):
#   1. packaged per track, installed; the setting off, Shut down everything      2. after the logon: Genie stayed down; then
#      the setting on, Shut down everything                                         3. after the logon: the launcher, the host
#      and a window; then the setting off, Just close the UI (left running)        4. after the logon: the launcher and the host,
#      no window.
Set-Content ci-rows.txt '-Only package-tracks'; In-Session scripts/ci/windows.ps1 60; if ($LASTEXITCODE) { exit $LASTEXITCODE }
Remove-Item ci-rows.txt
Set-Content logon-mode.txt 'install'; In-Session scripts/vm-logon-launcher-windows.ps1 15; if ($LASTEXITCODE) { exit $LASTEXITCODE }
Set-Content logon-mode.txt 'arm-off'; In-Session scripts/vm-logon-launcher-windows.ps1 15
#REBOOT
Set-Content logon-expect.txt 'none'; Set-Content logon-mode.txt 'after-logon'; In-Session scripts/vm-logon-launcher-windows.ps1 10; $a = $LASTEXITCODE
Set-Content logon-mode.txt 'arm-on'; In-Session scripts/vm-logon-launcher-windows.ps1 15; exit ($a + $LASTEXITCODE)
#REBOOT
Set-Content logon-expect.txt 'window'; Set-Content logon-mode.txt 'after-logon'; In-Session scripts/vm-logon-launcher-windows.ps1 10; $a = $LASTEXITCODE
Set-Content logon-mode.txt 'arm-left'; In-Session scripts/vm-logon-launcher-windows.ps1 15; exit ($a + $LASTEXITCODE)
#REBOOT
Set-Content logon-expect.txt 'hidden'; Set-Content logon-mode.txt 'after-logon'; In-Session scripts/vm-logon-launcher-windows.ps1 10
