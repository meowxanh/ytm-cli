# Stream API (yt-dlp) — bật cái này rồi mở web, mới lấy được stream ổn định
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Py = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) {
    Write-Host "Chua co venv. Chay: python3.12 -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt flask-cors"
    exit 1
}
Set-Location $Root
$env:PYTHONPATH = $Root
Write-Host "Stream API -> http://127.0.0.1:8765"
Write-Host "Web: https://meowxanh.github.io/ytm-cli/?api=http://127.0.0.1:8765"
Write-Host "Hoac PC: mo file docs\index.html qua local server + ?api=..."
& $Py stream_server.py
