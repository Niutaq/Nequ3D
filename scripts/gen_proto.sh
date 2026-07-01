#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$PROJECT_ROOT/.tools"
PROTOC_EXE="$TOOLS_DIR/bin/protoc"
PROTOC_VERSION="27.2"

OS="$(uname -s)"
ARCH="$(uname -m)"

if [ ! -f "$PROTOC_EXE" ]; then
    echo "Downloading protoc (Protobuf compiler) to $TOOLS_DIR..."
    mkdir -p "$TOOLS_DIR"
    
    ZIP_NAME=""
    if [ "$OS" = "Linux" ]; then
        if [ "$ARCH" = "x86_64" ]; then
            ZIP_NAME="protoc-${PROTOC_VERSION}-linux-x86_64.zip"
        elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
            ZIP_NAME="protoc-${PROTOC_VERSION}-linux-aarch_64.zip"
        fi
    elif [ "$OS" = "Darwin" ]; then
        if [ "$ARCH" = "x86_64" ]; then
            ZIP_NAME="protoc-${PROTOC_VERSION}-osx-x86_64.zip"
        elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
            ZIP_NAME="protoc-${PROTOC_VERSION}-osx-aarch_64.zip"
        fi
    fi

    if [ -z "$ZIP_NAME" ]; then
        echo "Unsupported OS/Architecture: $OS / $ARCH"
        exit 1
    fi

    URL="https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/${ZIP_NAME}"
    ZIP_PATH="$TOOLS_DIR/protoc.zip"
    
    curl -L -s "$URL" -o "$ZIP_PATH"
    unzip -q -o "$ZIP_PATH" -d "$TOOLS_DIR"
    rm "$ZIP_PATH"
    echo "Downloaded protoc!"
fi

echo "Installing Go plugins (protoc-gen-go, protoc-gen-go-grpc)..."
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

export PATH="$PATH:$(go env GOPATH)/bin"

OUTPUT_DIR="$PROJECT_ROOT/nequ3d-app/pipeline_rpc"
mkdir -p "$OUTPUT_DIR"

echo "Generating code for Go..."
"$PROTOC_EXE" --proto_path="$PROJECT_ROOT/proto" \
    --go_out="$OUTPUT_DIR" --go_opt=paths=source_relative \
    --go-grpc_out="$OUTPUT_DIR" --go-grpc_opt=paths=source_relative \
    "$PROJECT_ROOT/proto/pipeline/pipeline.proto"

echo "Go code generation successful! Output in: $OUTPUT_DIR"

echo "Installing dependencies and generating code for Python..."
PY_OUTPUT_DIR="$PROJECT_ROOT/processing/pipeline_rpc"
mkdir -p "$PY_OUTPUT_DIR"
touch "$PY_OUTPUT_DIR/__init__.py"

VENV_PYTHON="$PROJECT_ROOT/processing/venv/bin/python"
if [ ! -f "$VENV_PYTHON" ]; then
    VENV_PYTHON="python3"
fi

$VENV_PYTHON -m pip install grpcio-tools > /dev/null 2>&1 || true
$VENV_PYTHON -m grpc_tools.protoc -I="$PROJECT_ROOT/proto" \
    --python_out="$PY_OUTPUT_DIR" \
    --grpc_python_out="$PY_OUTPUT_DIR" \
    "$PROJECT_ROOT/proto/pipeline/pipeline.proto"

echo "All done! gRPC packages for Go and Python are updated."
