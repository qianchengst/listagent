param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Owner,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Repository,
  [Parameter(Mandatory = $true)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Tag,
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $false)][string]$Body = '',
  [Parameter(Mandatory = $true)][string[]]$Files
)

$ErrorActionPreference = 'Stop'
$maxAttachmentBytes = 90MB
$token = [Environment]::GetEnvironmentVariable('GITEE_TOKEN')
if ([string]::IsNullOrWhiteSpace($token)) { throw 'GITEE_TOKEN 未配置，已跳过 Gitee Release 同步。' }

$apiRoot = "https://gitee.com/api/v5/repos/$Owner/$Repository"
$headers = @{
  Authorization = "Bearer $token"
  Accept = 'application/json'
  'User-Agent' = 'listagent-gitee-release-sync'
}

function Invoke-GiteeJson {
  param([string]$Method, [string]$Uri, [object]$RequestBody = $null, [string]$ContentType = 'application/json')
  $parameters = @{ Method = $Method; Uri = $Uri; Headers = $headers }
  if ($null -ne $RequestBody) {
    $parameters.Body = $RequestBody
    $parameters.ContentType = $ContentType
  }
  Invoke-RestMethod @parameters
}

function Expand-GiteeUploadFiles {
  param([System.IO.FileInfo]$File, [string]$OutputDirectory)
  if ($File.Length -le $maxAttachmentBytes) { return @($File) }
  $parts = @()
  $buffer = New-Object byte[] (4MB)
  $inputStream = [System.IO.File]::OpenRead($File.FullName)
  try {
    $index = 1
    while ($inputStream.Position -lt $inputStream.Length) {
      $partName = '{0}.part{1:D2}' -f $File.Name, $index
      $partPath = Join-Path $OutputDirectory $partName
      $outputStream = [System.IO.File]::Create($partPath)
      try {
        $remaining = [Math]::Min($maxAttachmentBytes, $inputStream.Length - $inputStream.Position)
        while ($remaining -gt 0) {
          $requested = [int][Math]::Min($buffer.Length, $remaining)
          $read = $inputStream.Read($buffer, 0, $requested)
          if ($read -le 0) { break }
          $outputStream.Write($buffer, 0, $read)
          $remaining -= $read
        }
      } finally { $outputStream.Dispose() }
      $parts += Get-Item -LiteralPath $partPath
      $index++
    }
  } finally { $inputStream.Dispose() }
  Write-Host "已将 $($File.Name) 拆分为 $($parts.Count) 个 Gitee 附件（每个不超过 $([Math]::Round($maxAttachmentBytes / 1MB)) MB）。"
  return $parts
}

try {
  $release = Invoke-GiteeJson -Method Get -Uri "$apiRoot/releases/tags/$([uri]::EscapeDataString($Tag))"
} catch {
  if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
    $release = Invoke-GiteeJson -Method Post -Uri "$apiRoot/releases" -RequestBody @{
      tag_name = $Tag
      name = $Name
      body = $Body
      target_commitish = 'main'
      prerelease = $false
    } -ContentType 'application/x-www-form-urlencoded'
  } else {
    throw "读取 Gitee Release 失败：$($_.Exception.Message)"
  }
}

if (-not $release.id) { throw 'Gitee API 未返回 Release ID。' }
$releaseId = [string]$release.id
$existingAssets = @(Invoke-GiteeJson -Method Get -Uri "$apiRoot/releases/$releaseId/attach_files")
$sourceItems = @()
foreach ($file in $Files) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "找不到待上传的 Release 文件：$file" }
  $sourceItems += Get-Item -LiteralPath $file
}

$splitRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("listagent-gitee-release-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $splitRoot -Force | Out-Null
try {
  $fileItems = @()
  foreach ($file in $sourceItems) { $fileItems += Expand-GiteeUploadFiles -File $file -OutputDirectory $splitRoot }

  foreach ($file in $fileItems) {
    $old = $existingAssets | Where-Object { $_.name -eq $file.Name }
    foreach ($asset in @($old)) {
      Invoke-GiteeJson -Method Delete -Uri "$apiRoot/releases/$releaseId/attach_files/$($asset.id)" | Out-Null
    }
    $uploadUri = "$apiRoot/releases/$releaseId/attach_files"
    $form = @{ file = $file }
    Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $headers -Form $form | Out-Null
    Write-Host "已同步 Gitee Release 附件：$($file.Name)"
  }
} finally {
  Remove-Item -LiteralPath $splitRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Gitee Release 已就绪：https://gitee.com/$Owner/$Repository/releases/tag/$Tag"
