param(
    [string]$AllowedClientCidr,
    [string]$CertificateArn,
    [string]$DashboardDomain,
    [string]$FirebaseProjectId,
    [string]$FirebaseApiKey,
    [string]$FirebaseAuthDomain,
    [string]$FirebaseAppId
)

$ErrorActionPreference = 'Stop'
$CdkDirectory = $PSScriptRoot
$RepositoryRoot = (Resolve-Path (Join-Path $CdkDirectory '..\..')).Path
$Region = (& aws configure get region).Trim()
if (-not $Region) { $Region = $env:AWS_REGION }
if (-not $Region) { $Region = $env:AWS_DEFAULT_REGION }
if (-not $Region) { throw 'Set an AWS region with aws configure or AWS_REGION.' }

$IdentityJson = & aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI credentials could not be validated.' }
$Account = ($IdentityJson | ConvertFrom-Json).Account

$TempId = [guid]::NewGuid().ToString('N')
$StageDirectory = Join-Path $env:TEMP "finop-codebuild-$TempId"
$BundlePath = Join-Path $env:TEMP "finop-codebuild-$TempId.tar.gz"
$ImageTag = 'demo-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '-' + $TempId.Substring(0, 8)
$firebaseValues = @($FirebaseProjectId, $FirebaseApiKey, $FirebaseAuthDomain, $FirebaseAppId)
if (($firebaseValues | Where-Object { $_ } | Measure-Object).Count -notin @(0, 4)) {
    throw 'Provide all four Firebase web app values: FirebaseProjectId, FirebaseApiKey, FirebaseAuthDomain, and FirebaseAppId.'
}
if ($CertificateArn -and -not $DashboardDomain) { throw 'HTTPS deployment requires DashboardDomain matching the ACM certificate.' }
if (-not $CertificateArn -and $FirebaseProjectId) { Write-Host 'Firebase will use the HTTPS CloudFront URL created by the demo stack.' }

function Invoke-Cdk {
    param([string[]]$Arguments)
    Push-Location $CdkDirectory
    try {
        & npx.cmd cdk @Arguments
        if ($LASTEXITCODE -ne 0) { throw "CDK command failed with exit code $LASTEXITCODE." }
    } finally { Pop-Location }
}

function Get-StackOutputs {
    param([string]$StackName)
    $json = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --output json
    if ($LASTEXITCODE -ne 0) { throw "Could not read outputs for $StackName." }
    $outputs = @{}
    foreach ($item in ($json | ConvertFrom-Json).Stacks[0].Outputs) { $outputs[$item.OutputKey] = $item.OutputValue }
    return $outputs
}

New-Item -ItemType Directory -Path $StageDirectory | Out-Null
try {
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'Dockerfile') -Destination $StageDirectory
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'requirements.txt') -Destination $StageDirectory
    foreach ($directory in @('src', 'web', 'data\knowledge_base')) {
        $sourceDirectory = Join-Path $RepositoryRoot $directory
        $targetDirectory = Join-Path $StageDirectory $directory
        New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
        Get-ChildItem -LiteralPath $sourceDirectory -Force |
            Where-Object { $directory -ne 'web' -or $_.Name -notin @('node_modules', 'dist', '.vite') } |
            Copy-Item -Destination $targetDirectory -Recurse -Force
    }
    $sampleDataset = Join-Path $RepositoryRoot 'data\sample_superstore.csv'
    if (-not (Test-Path -LiteralPath $sampleDataset -PathType Leaf)) { throw 'The bundled Kaggle sample dataset is missing.' }
    $stagedDataDirectory = Join-Path $StageDirectory 'data'
    New-Item -ItemType Directory -Path $stagedDataDirectory -Force | Out-Null
    Copy-Item -LiteralPath $sampleDataset -Destination $stagedDataDirectory
    & tar.exe -czf $BundlePath -C $StageDirectory .
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the source tarball.' }

    Write-Host 'Deploying the remote image builder resources...'
    Invoke-Cdk @(
        'deploy', 'ImageBuilderStack', '--exclusively', '--require-approval', 'never',
        '-c', 'imageBuilderOnly=true'
    )
    $builderOutputs = Get-StackOutputs 'ImageBuilderStack'

    Write-Host 'Uploading the source bundle to the private S3 bucket...'
    & aws s3 cp $BundlePath "s3://$($builderOutputs.SourceBundleBucketName)/source.tar.gz" --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'Source bundle upload failed.' }

    Write-Host 'Starting the remote CodeBuild image build...'
    $started = & aws codebuild start-build --project-name $builderOutputs.BuildProjectName `
        --environment-variables-override "name=IMAGE_TAG,value=$ImageTag,type=PLAINTEXT" --region $Region --output json
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the CodeBuild image build.' }
    $buildId = ($started | ConvertFrom-Json).build.id
    do {
        Start-Sleep -Seconds 15
        $buildJson = & aws codebuild batch-get-builds --ids $buildId --region $Region --output json
        if ($LASTEXITCODE -ne 0) { throw 'Could not read CodeBuild status.' }
        $build = ($buildJson | ConvertFrom-Json).builds[0]
        Write-Host "CodeBuild status: $($build.buildStatus)"
    } while ($build.buildStatus -in @('IN_PROGRESS', 'QUEUED'))
    if ($build.buildStatus -ne 'SUCCEEDED') {
        throw "Remote image build ended with status $($build.buildStatus). Check the CodeBuild log group /aws/codebuild/finop-container-build."
    }

    $imageUri = "$($builderOutputs.ImageRepositoryUri):$ImageTag"
    Write-Host 'Deploying FINOP with the image built in AWS...'
    $deployArgs = @('deploy', 'FinopStack', '--exclusively', '--require-approval', 'never', '-c', "imageUri=$imageUri")
    if ($CertificateArn) {
        $deployArgs += @('-c', "certificateArn=$CertificateArn", '-c', "domainName=$DashboardDomain", '-c', "dashboardOrigin=https://$DashboardDomain")
    } else {
        $deployArgs += @('-c', 'demoHttp=true')
    }
    if ($FirebaseProjectId) {
        $deployArgs += @(
            '-c', "firebaseProjectId=$FirebaseProjectId",
            '-c', "firebaseApiKey=$FirebaseApiKey",
            '-c', "firebaseAuthDomain=$FirebaseAuthDomain",
            '-c', "firebaseAppId=$FirebaseAppId"
        )
    }
    Invoke-Cdk $deployArgs
    $appOutputs = Get-StackOutputs 'FinopStack'
    Write-Host "FINOP deployed: $($appOutputs.DashboardUrl)"
    Write-Host "ECS cluster: $($appOutputs.EcsClusterName)"
    if ($FirebaseProjectId) {
        Write-Host 'Firebase ID token verification is configured. Enable Email/Password, Google, and GitHub providers in Firebase Authentication.'
        Write-Host "Add $($appOutputs.DashboardDistributionDomain) to Firebase Authentication's authorized domains."
    }
} finally {
    if (Test-Path -LiteralPath $StageDirectory) { Remove-Item -LiteralPath $StageDirectory -Recurse -Force }
    if (Test-Path -LiteralPath $BundlePath) { Remove-Item -LiteralPath $BundlePath -Force }
}
