$ErrorActionPreference = 'Stop'
$quotaPython = (Get-Command python.exe -ErrorAction Stop).Source
$quotaPythonw = Join-Path (Split-Path -Parent $quotaPython) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $quotaPythonw)) { throw '找不到现有 Python 的 pythonw.exe；没有安装任何新依赖。' }
$quotaHelper = Join-Path $PSScriptRoot 'quota_launcher.py'
$quotaSource = Join-Path $PSScriptRoot 'dual-arc.js'
if (-not (Test-Path -LiteralPath $quotaHelper) -or -not (Test-Path -LiteralPath $quotaSource)) { throw '双弧文件不完整。' }
$quotaShell = New-Object -ComObject WScript.Shell
$quotaDesktop = [Environment]::GetFolderPath('Desktop')
$quotaPaths = @((Join-Path $PSScriptRoot 'ChatGPT 额度双弧.lnk'), (Join-Path $quotaDesktop 'ChatGPT 额度双弧.lnk'))
$quotaPackage = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
$quotaIcon = Join-Path $PSScriptRoot 'chatgpt.ico'
if ($quotaPackage -and ((-not (Test-Path -LiteralPath $quotaIcon)) -or (Get-Item -LiteralPath $quotaIcon).Length -lt 6)) {
    $quotaOriginalIcon = Join-Path $quotaPackage.InstallLocation 'app\resources\chatgpt-app-dark.ico'
    if (Test-Path -LiteralPath $quotaOriginalIcon) { [IO.File]::WriteAllBytes($quotaIcon,[IO.File]::ReadAllBytes($quotaOriginalIcon)) }
}
foreach ($quotaPath in $quotaPaths) {
    if (Test-Path -LiteralPath $quotaPath) {
        $quotaExisting = $quotaShell.CreateShortcut($quotaPath)
        if ($quotaExisting.Arguments -ne ('"' + $quotaHelper + '"')) { throw "同名快捷方式不属于本次定制，未覆盖：$quotaPath" }
    }
    $quotaLink = $quotaShell.CreateShortcut($quotaPath)
    $quotaLink.TargetPath = $quotaPythonw
    $quotaLink.Arguments = '"' + $quotaHelper + '"'
    $quotaLink.WorkingDirectory = $PSScriptRoot
    $quotaLink.Description = '官方 ChatGPT；上弧 5 小时、下弧一周；启动时适配已安装版本'
    if (Test-Path -LiteralPath $quotaIcon) { $quotaLink.IconLocation = $quotaIcon }
    $quotaLink.Save()
    Write-Output $quotaPath
}
$quotaRestorePath = Join-Path $PSScriptRoot '恢复原圆环.lnk'
if (Test-Path -LiteralPath $quotaRestorePath) {
    $quotaExisting = $quotaShell.CreateShortcut($quotaRestorePath)
    if ($quotaExisting.Arguments -ne ('"' + $quotaHelper + '" --stop')) { throw "同名恢复快捷方式不属于本次定制，未覆盖：$quotaRestorePath" }
}
$quotaRestore = $quotaShell.CreateShortcut($quotaRestorePath)
$quotaRestore.TargetPath = $quotaPythonw
$quotaRestore.Arguments = '"' + $quotaHelper + '" --stop'
$quotaRestore.WorkingDirectory = $PSScriptRoot
$quotaRestore.Description = '撤销双弧界面定制，保留当前 ChatGPT 窗口'
if (Test-Path -LiteralPath $quotaIcon) { $quotaRestore.IconLocation = $quotaIcon }
$quotaRestore.Save()
Write-Output $quotaRestorePath
