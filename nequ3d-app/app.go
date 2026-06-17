package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// App struct manages the application logic
type App struct{}

// OllamaRequest represents the request payload for the Ollama API
type OllamaRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Stream bool   `json:"stream"`
}

// OllamaResponse represents the response payload from the Ollama API
type OllamaResponse struct {
	Response string `json:"response"`
}

type AdvicePayload struct {
	Model              string          `json:"model"`
	AnalysisMode       string          `json:"analysis_mode"`
	NTCBypassed        bool            `json:"ntc_bypassed"`
	InstructionContext string          `json:"instruction_context"`
	Telemetry          json.RawMessage `json:"telemetry"`
	RawTelemetry       string          `json:"raw_telemetry"`
}

type SystemStats struct {
	Time      string  `json:"time"`
	GPU       float64 `json:"gpu"`
	VRAM      float64 `json:"vram"`
	Available bool    `json:"available"`
	Message   string  `json:"message,omitempty"`
}

// NewApp creates a new instance of the App
func NewApp() *App {
	return &App{}
}

// GenerateRenovationAdvice sends a request to the local Ollama API to generate renovation advice based on telemetry data
func (a *App) GenerateRenovationAdvice(telemetryJSON string) (string, error) {
	model, telemetryForPrompt, _ := normalizeAdvicePayload(telemetryJSON)

	// Task 2: Pre-compute NTC logic in Go for the LLM
	var telemetryMap map[string]interface{}
	if err := json.Unmarshal([]byte(telemetryForPrompt), &telemetryMap); err != nil {
		return "", fmt.Errorf("failed to unmarshal telemetry for advice: %v", err)
	}

	ntcBypassed, _ := telemetryMap["ntc_bypassed"].(bool)
	vramReductionStr, _ := telemetryMap["vram_reduction"].(string)
	if vramReductionStr == "" {
		vramReductionStr = "0%"
	}

	compressionStr := "NTC Compression: Active. VRAM Reduction: " + vramReductionStr
	if ntcBypassed {
		compressionStr = "NTC Compression: Bypassed. No VRAM savings."
	}

	// Task 3: Strict Anti-Conversational Prompt
	prompt := fmt.Sprintf(`You are a robotic data formatter. Output EXACTLY 3 bullet points.
CRITICAL: DO NOT start with "Sure, here are..." or any conversational text. ONLY output the bullets.

- Bullet 1: "Object: [deduce name from file_path or prim_names]"
- Bullet 2: "Geometry: [total_vertices] vertices, [total_faces] faces"
- Bullet 3: "%s"

JSON DATA:
%s`, compressionStr, telemetryForPrompt)

	reqBody := OllamaRequest{
		Model:  model,
		Prompt: prompt,
		Stream: false,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("failed to marshal JSON: %v", err)
	}

	client := &http.Client{Timeout: timeoutForModel(model)}
	resp, err := client.Post("http://localhost:11434/api/generate", "application/json", bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", fmt.Errorf("failed to connect to local AI. Is Ollama running? Error: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response: %v", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("local AI returned HTTP %d: %s", resp.StatusCode, trimForError(body))
	}

	var ollamaResp OllamaResponse
	if err := json.Unmarshal(body, &ollamaResp); err != nil {
		return "", fmt.Errorf("failed to parse AI response: %v", err)
	}

	return ollamaResp.Response, nil
}

func normalizeAdvicePayload(payload string) (string, string, string) {
	model := "gemma:2b"
	context := "Default mesh analysis."
	telemetry := payload

	var structured AdvicePayload
	if err := json.Unmarshal([]byte(payload), &structured); err == nil {
		model = sanitizeOllamaModel(structured.Model)
		if len(structured.Telemetry) > 0 && string(structured.Telemetry) != "null" {
			telemetry = string(structured.Telemetry)
		} else if structured.RawTelemetry != "" {
			telemetry = structured.RawTelemetry
		}
		return model, telemetry, context
	}

	return model, telemetry, context
}

func sanitizeOllamaModel(model string) string {
	switch strings.TrimSpace(model) {
	case "llama3", "llama3:8b":
		return "llama3"
	case "mistral", "mistral:7b":
		return "mistral"
	default:
		return "gemma:2b"
	}
}

func timeoutForModel(model string) time.Duration {
	switch model {
	case "llama3", "llama3:8b", "mistral", "mistral:7b":
		return 6 * time.Minute
	default:
		return 2 * time.Minute
	}
}

func trimForError(body []byte) string {
	text := strings.TrimSpace(string(body))
	if len(text) > 500 {
		return text[:500] + "..."
	}
	return text
}

func startGPUStatsTicker(app *application.App) {
	ticker := time.NewTicker(time.Second)
	go func() {
		defer ticker.Stop()
		for {
			emitGPUStats(app)
			<-ticker.C
		}
	}()
}

func emitGPUStats(app *application.App) {
	app.Event.Emit("sysStats", queryNVIDIAStats())
}

func queryNVIDIAStats() SystemStats {
	stats := SystemStats{Time: time.Now().Format("15:04:05")}
	output, err := exec.Command(
		"nvidia-smi",
		"--query-gpu=utilization.gpu,memory.used,memory.total",
		"--format=csv,noheader,nounits",
	).Output()

	if err != nil {
		stats.Available = false
		return stats
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) == 0 {
		stats.Available = false
		return stats
	}

	// Parsing first GPU
	parts := strings.Split(lines[0], ",")
	if len(parts) < 3 {
		stats.Available = false
		return stats
	}

	gpuUtil, err1 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	memUsed, err2 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	memTotal, err3 := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64)

	if err1 != nil || err2 != nil || err3 != nil || memTotal <= 0 {
		stats.Available = false
		return stats
	}

	stats.GPU = gpuUtil
	stats.VRAM = (memUsed / memTotal) * 100
	stats.Available = true
	return stats
}

// ProcessModel triggers the Docker pipeline for USD analysis or bypasses for GLB
func (a *App) ProcessModel(absolutePath string, bpp string) (string, error) {
	if absolutePath == "" {
		return "", fmt.Errorf("absolute path is empty")
	}

	if bpp == "" {
		return "", fmt.Errorf("bpp is empty")
	}

	// 1. FAST TRACK: If WebGL format (GLB/GLTF), bypass Core processing
	ext := strings.ToLower(filepath.Ext(absolutePath))
	if ext == ".glb" || ext == ".gltf" {
		proxyResponse, err := json.Marshal(map[string]any{
			"status":               "proxy_mode",
			"message":              "WebGL format loaded (GLB/GLTF).",
			"details":              "Bypassed OpenUSD Core Analysis. Displaying 3D proxy viewer.",
			"file_path":            absolutePath,
			"proxy_glb_path":       absolutePath,
			"ntc_bypassed":         true,
			"ntc_bypass_reason":    "GLB/GLTF proxy mode does not run the USD texture compression pipeline.",
			"has_ntc_quality":      false,
			"ntc_compressed_files": []any{},
		})
		if err != nil {
			return "", fmt.Errorf("failed to marshal proxy telemetry: %v", err)
		}

		return string(proxyResponse), nil
	}

	if ext == ".splat" || ext == ".ply" {
		response, err := json.Marshal(map[string]any{
			"status":                 "environment_only",
			"message":                "Gaussian splat environment selected.",
			"environment_splat_path": absolutePath,
			"ntc_bypassed":           true,
			"ntc_bypass_reason":      "3DGS environments are not processed by Neural Texture Compression.",
			"has_ntc_quality":        false,
			"ntc_compressed_files":   []any{},
		})
		if err != nil {
			return "", fmt.Errorf("failed to marshal splat telemetry: %v", err)
		}
		return string(response), nil
	}

	if !isUSDAssetExtension(ext) {
		return "", fmt.Errorf("unsupported asset format %q", ext)
	}

	// 2. PRODUCTION PIPELINE: Execute MLOps Docker Container for OpenUSD
	modelDir := filepath.Dir(absolutePath)
	fileName := filepath.Base(absolutePath)

	// Docker CLI execution arguments
	cmdArgs := []string{
		"run", "--rm", "--gpus", "all",
		"-v", fmt.Sprintf("%s:/workspace", modelDir),
		"nequ3d-core:latest",
		"python3", "/app/process_usd_file.py",
		fmt.Sprintf("/workspace/%s", fileName),
		bpp,
	}

	cmd := exec.Command("docker", cmdArgs...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("stdout pipe error: %v", err)
	}

	// Merge Stderr into Stdout to capture Python and CUDA exceptions uniformly
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("failed to start Docker container: %v", err)
	}

	var jsonResult string
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)

	// Stream and parse Docker output line-by-line
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Println("[Docker Core Stream]", line)

		if p, ok := strings.CutPrefix(line, "Telemetry: "); ok {
			jsonResult = p
		}
	}

	if err := scanner.Err(); err != nil {
		fmt.Println("[Edge Router] Scanner stream error:", err)
	}

	// Wait for process completion to release GPU resources
	if err := cmd.Wait(); err != nil {
		return "", fmt.Errorf("docker execution failed (check terminal for GPU logs): %v", err)
	}

	if jsonResult == "" {
		return "", fmt.Errorf("container executed successfully but returned no JSON telemetry")
	}

	return jsonResult, nil
}

func isUSDAssetExtension(ext string) bool {
	switch strings.ToLower(ext) {
	case ".usd", ".usdc", ".usda", ".usdz":
		return true
	default:
		return false
	}
}

// SelectFile prompts the user with a system dialog to pick a 3D asset
func (a *App) SelectFile() (string, error) {
	path, err := application.Get().Dialog.OpenFile().
		SetTitle("Nequ3D: Select OpenUSD Asset").
		AddFilter("Nequ3D Assets", "*.usd;*.usdc;*.usda;*.usdz;*.glb;*.gltf").
		AddFilter("OpenUSD", "*.usd;*.usdc;*.usda;*.usdz").
		AddFilter("WebGL Mesh Proxy", "*.glb;*.gltf").
		AddFilter("All Files", "*.*").
		PromptForSingleSelection()

	if err != nil {
		return "", fmt.Errorf("dialog error: %v", err)
	}

	return path, nil
}
