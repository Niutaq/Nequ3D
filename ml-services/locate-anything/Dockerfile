FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

# Ustawienie zmiennych środowiskowych
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Instalacja zależności systemowych
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    git \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalacja zależności Pythona
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Kopiowanie kodu aplikacji
COPY main.py .

# Uruchomienie serwera FastAPI
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
