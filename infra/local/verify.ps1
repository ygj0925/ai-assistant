#Requires -Version 7.2

[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$Wsl
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$backendSource = Join-Path $projectRoot 'services/api'
$siblingBackend = Join-Path $projectRoot '../ai-assistant-api'
if (-not (Test-Path -LiteralPath (Join-Path $backendSource 'continew-assistant/pom.xml')) -and
    (Test-Path -LiteralPath (Join-Path $siblingBackend 'continew-assistant/pom.xml'))) {
    $backendSource = $siblingBackend
}
$backend = Join-Path $backendSource 'continew-server/target/app'
$migrationProbe = Join-Path $projectRoot 'qa/ContiNewMigrationProbe.java'
$storageProbe = Join-Path $PSScriptRoot 'ObjectStorageProbe.java'
$fixture = Join-Path $PSScriptRoot 'fixtures/reference.txt'

function Invoke-LocalCompose([string[]]$Command) {
    $pathArguments = @('--env-file', '.env', '-f', 'compose.yaml')
    if ($Wsl) {
        & wsl.exe --exec docker compose @pathArguments @Command
    } else {
        & docker compose @pathArguments @Command
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose command '$($Command[0])' failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Probe([string]$Source, [hashtable]$Environment, [string[]]$ProbeArguments) {
    $previous = @{}
    foreach ($name in $Environment.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $Environment[$name])
    }
    Push-Location $backend
    try {
        $classpath = 'config' + [IO.Path]::PathSeparator + 'lib/*'
        & java --class-path $classpath $Source @ProbeArguments
        if ($LASTEXITCODE -ne 0) {
            throw "Probe failed: $([IO.Path]::GetFileName($Source))"
        }
    } finally {
        Pop-Location
        foreach ($name in $previous.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previous[$name])
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $backend 'lib'))) {
    throw "Build the continew-server module in '$backendSource' first so the probe can use its runtime dependencies"
}

Push-Location $PSScriptRoot
try {
    $config = Invoke-LocalCompose @('config', '--format', 'json') | ConvertFrom-Json
    if ($Start) {
        Invoke-LocalCompose @('up', '-d', '--wait', '--wait-timeout', '90')
    }

    $redisKey = 'assistant:qa:' + [Guid]::NewGuid().ToString('N')
    $redisValue = 'assistant-local-fixture'
    $set = Invoke-LocalCompose @('exec', '-T', 'redis', 'redis-cli', '--raw', '-e',
        'SET', $redisKey, $redisValue, 'EX', '60')
    $get = Invoke-LocalCompose @('exec', '-T', 'redis', 'redis-cli', '--raw', '-e', 'GET', $redisKey)
    if ($set -ne 'OK' -or $get -ne $redisValue) {
        throw 'Redis fixture round trip failed'
    }
    Write-Output 'Redis round trip passed'

    $postgresPort = ($config.services.postgres.ports | Where-Object target -eq 5432).published
    $database = 'assistant_qa_' + [Guid]::NewGuid().ToString('N')
    $psql = @('exec', '-T', 'postgres', 'psql', '--no-psqlrc', '--username=postgres',
        '--dbname=postgres', '--set=ON_ERROR_STOP=1', '--command')
    Invoke-LocalCompose ($psql + "CREATE DATABASE $database OWNER assistant_qa;")
    try {
        Invoke-Probe $migrationProbe @{
            QA_POSTGRES_URL = "jdbc:postgresql://127.0.0.1:$postgresPort/$database"
            DB_USER = 'assistant_qa'
            DB_PWD = $config.services.postgres.environment.ASSISTANT_QA_DB_PASSWORD
        } @()
    } finally {
        Invoke-LocalCompose ($psql + "DROP DATABASE $database;")
    }

    $s3 = $config.services.'object-store'
    $s3Port = ($s3.ports | Where-Object target -eq 8333).published
    Invoke-Probe $storageProbe @{
        QA_S3_ENDPOINT = "http://127.0.0.1:$s3Port"
        QA_S3_BUCKET = $s3.environment.S3_BUCKET
        QA_S3_ACCESS_KEY = $s3.environment.AWS_ACCESS_KEY_ID
        QA_S3_SECRET_KEY = $s3.environment.AWS_SECRET_ACCESS_KEY
    } @($fixture)
} finally {
    Pop-Location
}
