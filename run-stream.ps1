# SoundCloud Stream API (nhe, khong yt-dlp)
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Py = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) {
    Write-Host "Chua co venv. Chay: python3.12 -m venv .venv; .\.venv\Scripts\pip install -r requirements-stream.txt"
    exit 1
}
Set-Location $Root
Write-Host "YTM SoundCloud API -> http://127.0.0.1:8765"
Write-Host "Web: https://meowxanh.github.io/ytm-cli/  (tu dong nhan localhost)"
& $Py -m pip install -q -r requirements-stream.txt
& $Py stream_server.py
