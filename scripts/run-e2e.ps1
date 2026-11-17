$ErrorActionPreference = 'Continue'
Set-Location g:\workspace_trae\StoryForgeAI
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    $name = $matches[1].Trim()
    $value = $matches[2].Trim().Trim('"').Trim("'")
    if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}
Write-Output "AUTHOR_EMAIL=$env:AUTHOR_EMAIL"
Write-Output "DATABASE_URL=$env:DATABASE_URL"
npx playwright test "$($args -join ' ')" --config playwright.config.ts
exit $LASTEXITCODE