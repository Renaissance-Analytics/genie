#az os=windows size=Standard_D4ads_v5 fetch=ci-out timeout=4800
# A REAL LOGON ON WINDOWS (Tynn #1036 P6-3, task #1501), for the envelope's queue: bash scripts/azure/q.sh submit <tree> <this file>.
# Three stages, the VM restarted between them and genie logged on again by autologon (run-job.sh's #REBOOT):
#   1. packaged and installed; the setting off, Shut down everything        2. after the logon: Genie stayed down;
#      then the setting on with start minimised, Shut down everything        3. after the logon: Genie is back, hidden.
# A break probe: Set-Content logon-break.txt 'no-entry' (or 'stale-entry') at the top of each stage of a copy of this file.
Set-Content ci-rows.txt '-Only package'; In-Session scripts/ci/windows.ps1 45; if ($LASTEXITCODE) { exit $LASTEXITCODE }
Remove-Item ci-rows.txt
Set-Content logon-mode.txt 'install'; In-Session scripts/vm-logon-windows.ps1 10; if ($LASTEXITCODE) { exit $LASTEXITCODE }
Set-Content logon-mode.txt 'arm-off'; In-Session scripts/vm-logon-windows.ps1 15
#REBOOT
Set-Content logon-expect.txt 'none'; Set-Content logon-mode.txt 'after-logon'; In-Session scripts/vm-logon-windows.ps1 10; $none = $LASTEXITCODE
Set-Content logon-mode.txt 'arm-on'; In-Session scripts/vm-logon-windows.ps1 15; $arm = $LASTEXITCODE
exit ($none + $arm)
#REBOOT
Set-Content logon-expect.txt 'start'; Set-Content logon-mode.txt 'after-logon'; In-Session scripts/vm-logon-windows.ps1 10
