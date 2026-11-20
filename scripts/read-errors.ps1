$dir = 'g:\workspace_trae\StoryForgeAI\test-results\playwright'
Get-ChildItem $dir -Recurse -Filter 'error-context*' -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output ("==== " + $_.FullName)
  Get-Content $_.FullName -ErrorAction SilentlyContinue | Select-Object -First 45
}