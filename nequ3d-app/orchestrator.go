package main

import (
	"bufio"
	"fmt"
	"log/slog"
	"os/exec"
	"sync"
)

var (
	coreWorkerCmd *exec.Cmd
	workerMutex   sync.Mutex
)

// StartCoreWorker spins up the Python Docker container in the background
// and streams its logs into the Go application's standard output.
func StartCoreWorker() {
	workerMutex.Lock()
	defer workerMutex.Unlock()

	// Ensure no stale container is hanging around
	exec.Command("docker", "rm", "-f", "nequ3d-worker").Run()

	slog.Info("[Orchestrator] Starting Python OpenUSD Worker (Docker)...")

	coreWorkerCmd = exec.Command("docker", "run",
		"--rm",
		"--name", "nequ3d-worker",
		"--gpus", "all",
		"-e", "MINIO_ENDPOINT=http://host.docker.internal:9000",
		"-p", "50051:50051",
		"-p", "8001:8001",
		"nequ3d-core:v5",
	)

	stdout, err := coreWorkerCmd.StdoutPipe()
	if err != nil {
		slog.Error("[Orchestrator] Stdout pipe error", "err", err)
		return
	}
	// Merge stderr into stdout
	coreWorkerCmd.Stderr = coreWorkerCmd.Stdout 

	if err := coreWorkerCmd.Start(); err != nil {
		slog.Error("[Orchestrator] Failed to start container", "err", err)
		return
	}

	// Stream logs asynchronously
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			fmt.Printf("[Worker]: %s\n", scanner.Text())
		}
		if err := scanner.Err(); err != nil {
			slog.Error("[Orchestrator] Log stream error", "err", err)
		}
		slog.Warn("[Orchestrator] Worker process terminated.")
	}()
}

// StopCoreWorker gracefully shuts down the Python container when the app closes.
func StopCoreWorker() {
	workerMutex.Lock()
	defer workerMutex.Unlock()

	if coreWorkerCmd != nil && coreWorkerCmd.Process != nil {
		slog.Info("[Orchestrator] Stopping Python container (Graceful Shutdown)...")
		killCmd := exec.Command("docker", "rm", "-f", "nequ3d-worker")
		if err := killCmd.Run(); err != nil {
			slog.Error("[Orchestrator] Error killing container", "err", err)
		} else {
			slog.Info("[Orchestrator] Worker successfully shut down.")
		}
	}
}

var (
	minioProxyCmd *exec.Cmd
	minioMutex    sync.Mutex
)

// StartMinioProxy starts the kubectl port-forward for MinIO in the background
func StartMinioProxy() {
	minioMutex.Lock()
	defer minioMutex.Unlock()

	slog.Info("[Orchestrator] Starting MinIO Port-Forward (kubectl)...")

	// Pre-kill any hanging port-forward processes on Windows using PowerShell (best effort)
	exec.Command("powershell", "-Command", "Stop-Process -Name kubectl -Force -ErrorAction SilentlyContinue").Run()

	minioProxyCmd = exec.Command("kubectl", "port-forward", "svc/minio", "9000:9000", "-n", "minio")

	stdout, err := minioProxyCmd.StdoutPipe()
	if err != nil {
		slog.Error("[Orchestrator] MinIO Stdout pipe error", "err", err)
		return
	}
	minioProxyCmd.Stderr = minioProxyCmd.Stdout

	if err := minioProxyCmd.Start(); err != nil {
		slog.Error("[Orchestrator] Failed to start MinIO proxy", "err", err)
		return
	}

	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			fmt.Printf("[MinIO-Proxy]: %s\n", scanner.Text())
		}
		slog.Warn("[Orchestrator] MinIO Proxy process terminated.")
	}()
}

// StopMinioProxy gracefully kills the kubectl port-forward
func StopMinioProxy() {
	minioMutex.Lock()
	defer minioMutex.Unlock()

	if minioProxyCmd != nil && minioProxyCmd.Process != nil {
		slog.Info("[Orchestrator] Stopping MinIO proxy...")
		minioProxyCmd.Process.Kill()
	}
}
