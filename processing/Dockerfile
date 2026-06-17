# ==========================================
# Nequ3D Core Environment (Edge-to-Core Pipeline)
# Base: Ubuntu 22.04 with CUDA 12.1 Development Tools
# ==========================================
FROM nvidia/cuda:12.1.1-devel-ubuntu22.04

# Disable interactive prompts during apt-get
ENV DEBIAN_FRONTEND=noninteractive

# 1. Install system dependencies, Python, and C++ Headless build requirements
RUN apt-get update && apt-get install -y \
    python3 python3-pip git cmake build-essential \
    pkg-config libx11-dev libxcursor-dev libxrandr-dev libxinerama-dev libxi-dev \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Pixar OpenUSD Framework
RUN pip3 install usd-core

# 3. Clone and Patch NVIDIA RTXNTC Repository
WORKDIR /opt
RUN git clone --recursive https://github.com/NVIDIA-RTX/RTXNTC.git

WORKDIR /opt/RTXNTC
# Apply engineering patches to bypass CUDA 12.1 compilation errors
RUN sed -i 's/grid.thread_index().x;/blockIdx.x * blockDim.x + threadIdx.x;/g' libraries/RTXNTC-Library/src/Optimizer.cu && \
    sed -i 's/grid.thread_index().y;/blockIdx.y * blockDim.y + threadIdx.y;/g' libraries/RTXNTC-Library/src/Optimizer.cu && \
    sed -i 's/dim3 globalIdx = gg.thread_index();/dim3 globalIdx(blockIdx.x * blockDim.x + threadIdx.x, blockIdx.y * blockDim.y + threadIdx.y, blockIdx.z * blockDim.z + threadIdx.z);/g' libraries/RTXNTC-Library/src/Quantizer.cu && \
    sed -i '1s/^/#define MAX_MACRO(a, b) ((a) > (b) ? (a) : (b))\n/' libraries/RTXNTC-Library/src/tin/tin_activation.h && \
    sed -i 's/std::max/MAX_MACRO/g' libraries/RTXNTC-Library/src/tin/tin_activation.h && \
    sed -i 's/MAX_MACRO<T>/MAX_MACRO/g' libraries/RTXNTC-Library/src/tin/tin_activation.h

# 4. Headless RTXNTC Compilation (ntc-cli tool only, target architectures: Ampere & Ada)
WORKDIR /opt/RTXNTC/build
RUN cmake -DCMAKE_CUDA_ARCHITECTURES="86;89" -DDONUT_WITH_GLFW=OFF -DGLFW_BUILD_WAYLAND=OFF -DBUILD_SHARED_LIBS=OFF .. && \
    make ntc-cli -j

# Expose executable globally
RUN ln -s /opt/RTXNTC/bin/linux-x64/ntc-cli /usr/local/bin/ntc-cli

# 5. Initialize Nequ3D Core Workspace
WORKDIR /app
COPY . /app/

# Standby execution state
CMD ["/bin/bash"]
