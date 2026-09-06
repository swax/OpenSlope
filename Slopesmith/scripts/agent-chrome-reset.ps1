# Clears ONLY the chrome-devtools-mcp browser, leaving the user's personal Chrome untouched.
#
# The MCP server owns a private Chrome profile (~/.cache/chrome-devtools-mcp/chrome-profile). When a prior
# session leaves it running, every MCP call fails with "The browser is already running", and a PARTIAL kill
# leaves the server split-brained: list_pages / navigate_page report the editor tab while evaluate_script and
# take_snapshot still target a stale about:blank. Both states need every MCP-owned process gone.
#
# Matching on the command line (not the image name) is what keeps an ordinary Chrome session safe — those
# processes never carry the chrome-devtools-mcp profile path.
#
# Usage:  pwsh -File scripts/agent-chrome-reset.ps1

$mcp = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'chrome-devtools-mcp' })

if ($mcp.Count -eq 0) {
  Write-Output "No MCP-owned Chrome processes running - nothing to reset."
} else {
  $mcp | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Milliseconds 1500
}

$left     = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'chrome-devtools-mcp' })
$personal = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -notmatch 'chrome-devtools-mcp' })

Write-Output "killed: $($mcp.Count) | mcp remaining: $($left.Count) | personal Chrome untouched: $($personal.Count)"
if ($left.Count -gt 0) { Write-Output "WARNING: MCP processes survived - a new_page will still fail."; exit 1 }
