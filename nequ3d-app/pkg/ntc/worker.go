package ntc

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"sync"
)

// Job represents a single texture compression task
type Job struct {
	ID             string
	SourceFilePath string
	OutputFilePath string
	// Target architecture will use the shared memory mapping name here
	SharedMemoryHandle string
}

// Result represents the outcome of a compression job
type Result struct {
	JobID            string
	Error            error
	CompressionRatio float32
	DurationMs       int64
}

type WorkerState string

const (
	StateIdle        WorkerState = "IDLE"
	StateCompressing WorkerState = "COMPRESSING"
	StateFault       WorkerState = "FAULT" // Triggered when the C++ process segfaults
)

// RTXWorker isolates and manages the lifecycle of the external C++ RTXNTC daemon
type RTXWorker struct {
	mu           sync.RWMutex
	state        WorkerState
	executable   string
	activeCmd    *exec.Cmd
	jobQueue     chan Job
	resultStream chan Result
}

func NewRTXWorker(executablePath string) *RTXWorker {
	return &RTXWorker{
		state:        StateIdle,
		executable:   executablePath,
		jobQueue:     make(chan Job, 10),
		resultStream: make(chan Result, 10),
	}
}

// Run starts the listener loop to manage incoming jobs and the subprocess
func (w *RTXWorker) Run(ctx context.Context) {
	log.Println("[RTXWorker] Initializing IPC manager...")
	for {
		select {
		case <-ctx.Done():
			w.terminateProcess()
			return
		case job := <-w.jobQueue:
			w.processJob(ctx, job)
		}
	}
}

func (w *RTXWorker) processJob(ctx context.Context, job Job) {
	w.setState(StateCompressing)
	defer w.setState(StateIdle)

	// Structural draft - executing the external C++ binary
	args := []string{"--compress", "--input", job.SourceFilePath, "--output", job.OutputFilePath}
	w.activeCmd = exec.CommandContext(ctx, w.executable, args...)

	err := w.activeCmd.Run()
	
	// Error analysis (Segfault vs Logical Error)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			log.Printf("[RTXWorker] FAULT DETECTED: C++ process died violently. Exit Code: %d", exitErr.ExitCode())
			w.setState(StateFault)
			// The host Go process survives and reports the error upstream.
		}
		
		w.resultStream <- Result{JobID: job.ID, Error: fmt.Errorf("compression failed: %w", err)}
		return
	}

	w.resultStream <- Result{JobID: job.ID, Error: nil}
}

func (w *RTXWorker) setState(s WorkerState) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.state = s
}

func (w *RTXWorker) terminateProcess() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.activeCmd != nil && w.activeCmd.Process != nil {
		w.activeCmd.Process.Kill()
	}
}
