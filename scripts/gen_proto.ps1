$ErrorActionPreference = "Stop"
$ProjectRoot = (Get-Item -Path ".\").FullName
$ToolsDir = "$ProjectRoot\.tools"
$ProtocExe = "$ToolsDir\bin\protoc.exe"

if (-not (Test-Path $ProtocExe)) {
    Write-Host "Downloading protoc (Protobuf compiler) to $ToolsDir..."
    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
    $Url = "https://github.com/protocolbuffers/protobuf/releases/download/v27.2/protoc-27.2-win64.zip"
    $ZipPath = "$ToolsDir\protoc.zip"
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath
    Expand-Archive -Path $ZipPath -DestinationPath $ToolsDir -Force
    Remove-Item $ZipPath
    Write-Host "Downloaded protoc!"
}

Write-Host "Installing Go plugins (protoc-gen-go, protoc-gen-go-grpc)..."
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

$GoBin = "$env:USERPROFILE\go\bin"
if ($env:PATH -notmatch [regex]::Escape($GoBin)) {
    $env:PATH += ";$GoBin"
}

$OutputDir = "$ProjectRoot\nequ3d-app\pipeline_rpc"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "Generating code for Go..."
& $ProtocExe --proto_path="$ProjectRoot\proto" --go_out="$OutputDir" --go_opt=paths=source_relative --go-grpc_out="$OutputDir" --go-grpc_opt=paths=source_relative "$ProjectRoot\proto\pipeline\pipeline.proto"

Write-Host "Go code generation successful! Output in: $OutputDir"

Write-Host "Installing dependencies and generating code for Python..."
$PyOutputDir = "$ProjectRoot\processing\pipeline_rpc"
New-Item -ItemType Directory -Force -Path $PyOutputDir | Out-Null
New-Item -ItemType File -Force -Path "$PyOutputDir\__init__.py" | Out-Null

$VenvPython = "$ProjectRoot\processing\venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    $VenvPython = "python"
}

& $VenvPython -m pip install grpcio-tools
& $VenvPython -m grpc_tools.protoc -I="$ProjectRoot\proto" --python_out="$PyOutputDir" --grpc_python_out="$PyOutputDir" "$ProjectRoot\proto\pipeline\pipeline.proto"

Write-Host "All done! gRPC packages for Go and Python are updated."
