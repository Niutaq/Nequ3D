// Package and libraries
package main

import (
	// Standard library
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	// Chi router and middleware
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
)

// rawData is the path to the raw data directory
const rawData = "../data/raw"

// Structs
// ModelInfo holds information about a model
type ModelInfo struct {
	Name       string `json:"name"`
	SizeBytes  int64  `json:"size_bytes"`
	UploadedAt string `json:"uploaded_at"`
}

// main is the entry point of the application
func main() {
	// Logger setup
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	slog.SetDefault(logger)

	if err := os.MkdirAll(rawData, os.ModePerm); err != nil {
		slog.Error("Failed to create raw data directory", "error", err)
		os.Exit(1)
	}

	// Router setup
	r := chi.NewRouter()

	// Middleware options
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	// CORS middleware options
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"http://localhost:*"},
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: bool(true),
		MaxAge:           300,
	}))

	fileServer := http.FileServer(http.Dir("../data/raw"))
	r.Handle("/raw/*", http.StripPrefix("/raw/", fileServer))
	r.Handle("/*", http.FileServer(http.Dir("../viewer")))

	// Routes for file upload and model management
	r.Post("/upload", uploadHandler)
	r.Get("/models", modelsHandler)

	slog.Info("OpenUSD server started", "port", ":8080")
	if err := http.ListenAndServe(":8080", r); err != nil {
		slog.Error("Failed to start server", "error", err)
		os.Exit(1)
	}
}

// ---
// uploadHandler handles the file upload request
func uploadHandler(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		slog.Warn("Failed to parse multipart form", "error", err)
		http.Error(w, "Failed to parse multipart form", http.StatusBadRequest)
		return
	}

	file, handler, err := r.FormFile("file")
	if err != nil {
		slog.Warn("Failed to get file from form", "error", err)
		http.Error(w, "Failed to get file from form", http.StatusBadRequest)
		return
	}

	defer file.Close()

	safeFilename := filepath.Base(handler.Filename)
	dstPath := filepath.Join(rawData, safeFilename)

	dst, err := os.Create(dstPath)
	if err != nil {
		slog.Warn("Failed to create destination file", "error", err)
		http.Error(w, "Failed to create destination file", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		slog.Warn("Failed to save file", "error", err)
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, "File uploaded successfully: %s\n", safeFilename)
}

// ---
// modelsHandler handles the request for available models
func modelsHandler(w http.ResponseWriter, r *http.Request) {
	files, err := os.ReadDir(rawData)
	if err != nil {
		slog.Warn("Failed to read raw data directory", "error", err)
		http.Error(w, "Failed to read raw data directory", http.StatusInternalServerError)
		return
	}

	var models []ModelInfo
	for _, file := range files {
		if !file.IsDir() {
			info, err := file.Info()
			if err != nil {
				continue
			}
			models = append(models, ModelInfo{
				Name:       info.Name(),
				SizeBytes:  info.Size(),
				UploadedAt: info.ModTime().Format(time.RFC3339),
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(models)
}

// runOmniverseWorker starts a worker that processes the given USD file using Omniverse
func runOmniverseWorker(filename string) {
	go func() {
		slog.Info("Omniverse worker started", "filename", filename)

		// Construct the path to the Python executable and the script + input file
		pythonExec := filepath.Join("..", "processing", "venv", "Scripts", "python.exe")

		scriptPath := filepath.Join("..", "processing", "process_usd_file.py")
		inputPath := filepath.Join(rawData, filename)

		// Create the command to run the Python script
		cmd := exec.Command(pythonExec, scriptPath, inputPath)

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			slog.Error("Failed to create stdout pipe", "error", err)
			return
		}

		if err := cmd.Start(); err != nil {
			slog.Error("Failed to start command", "error", err)
			return
		}

		// Read output from the command
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			slog.Info("Output", "line", scanner.Text())
		}
		// Check for errors reading output
		if err := scanner.Err(); err != nil {
			slog.Error("Failed to read output", "error", err)
		}

		// Wait for the command to finish and check for errors
		if err := cmd.Wait(); err != nil {
			slog.Error("Command failed", "error", err)
		}

		slog.Info("Omniverse worker finished", "filename", filename)
	}()
}
