# Prompts for the MongoDB connection string (input hidden) and writes it to the
# MONGODB_URI line of .env. The value is never printed.
$envPath = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envPath)) { Write-Host '.env not found. Copy .env.example to .env first.'; exit 1 }

$secure = Read-Host 'Paste your MongoDB connection string, then press Enter (input is hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $uri = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if ($uri -notmatch '^mongodb(\+srv)?://') { Write-Host 'That does not look like a MongoDB connection string (it should start with mongodb+srv://). Nothing was changed.'; exit 1 }
if ($uri -match '[<>]') { Write-Host 'The string still contains <...> placeholders such as <db_password>. Replace them with real values and run this again. Nothing was changed.'; exit 1 }

$lines = Get-Content -LiteralPath $envPath
$found = $false
$lines = $lines | ForEach-Object {
  if ($_ -match '^MONGODB_URI=') { $found = $true; "MONGODB_URI=$uri" } else { $_ }
}
if (-not $found) { $lines += "MONGODB_URI=$uri" }
[IO.File]::WriteAllLines((Resolve-Path $envPath), $lines)
Remove-Variable uri
Write-Host 'Saved. MONGODB_URI in .env has been updated. You can close this tab.'
