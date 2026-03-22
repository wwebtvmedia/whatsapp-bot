# restore-mongo.ps1
$latestBackup = Get-ChildItem -Path "backups" -Filter *.archive | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $latestBackup) {
    Write-Host "❌ No backup archive found in the 'backups' folder."
    exit
}

$containerName = "mongo"

docker exec -i $containerName mongorestore --archive < $latestBackup.FullName

Write-Host "✅ MongoDB restored from: $($latestBackup.Name)"
