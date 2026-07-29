# Launch YTM Web UI
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Py = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) {
    Write-Host "Chua co venv. Chay: python3.12 -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt"
    exit 1
}
Set-Location $Root
Write-Host "YTM Web -> http://127.0.0.1:5050"
& $Py -c "from ytm.webapp import main; main()"
