# Launch YTM CLI
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Py = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) {
    Write-Host "Chua co venv. Chay: python3.12 -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt"
    exit 1
}
Set-Location $Root
& $Py -m ytm @args
