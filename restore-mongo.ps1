# restore-mongo.ps1
$latestBackup = Get-ChildItem -Path "backups" -Filter *.archive | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $latestBackup) {
    Write-Host "❌ No backup archive found in the 'backups' folder."
    exit
}

# Containers are named by compose (no fixed container_name in docker-compose.yml),
# so resolve the stack's Mongo through its compose labels.
$projectName = "whatsapp-bot"
$serviceName = "mongo"
$containerName = docker ps --filter "label=com.docker.compose.project=$projectName" --filter "label=com.docker.compose.service=$serviceName" --format "{{.Names}}" | Select-Object -First 1

if (-not $containerName) {
    Write-Host "❌ No running '$serviceName' container found for project '$projectName'. Is the stack up? (./install.sh)"
    exit 1
}

docker exec -i $containerName mongorestore --archive < $latestBackup.FullName

Write-Host "✅ MongoDB restored from: $($latestBackup.Name)"
