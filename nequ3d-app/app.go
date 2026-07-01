package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	pb "changeme/pipeline_rpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// App struct manages the application logic
type App struct{}

// OllamaRequest represents the request payload for the Ollama API
type OllamaRequest struct {
	Model  string   `json:"model"`
	Prompt  string                 `json:"prompt"`
	Stream  bool                   `json:"stream"`
	Images  []string               `json:"images,omitempty"`
	Options map[string]interface{} `json:"options,omitempty"`
}

// OllamaResponse represents the response payload from the Ollama API
type OllamaResponse struct {
	Response string `json:"response"`
}

type AdvicePayload struct {
	Model              string          `json:"model"`
	Language           string          `json:"language"`
	AnalysisMode       string          `json:"analysis_mode"`
	NTCBypassed        bool            `json:"ntc_bypassed"`
	InstructionContext string          `json:"instruction_context"`
	Telemetry          json.RawMessage `json:"telemetry"`
	RawTelemetry       string          `json:"raw_telemetry"`
	ImageBase64        string          `json:"image_base64,omitempty"`
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
	model, telemetryForPrompt, _, imageBase64 := normalizeAdvicePayload(telemetryJSON)
	// Task 2: Pre-compute NTC logic in Go for the LLM
	var telemetryMap map[string]any
	if err := json.Unmarshal([]byte(telemetryForPrompt), &telemetryMap); err != nil {
		return "", fmt.Errorf("failed to unmarshal telemetry for advice: %v", err)
	}

	language, _ := telemetryMap["language"].(string)
	language = strings.TrimSpace(language)
	if language == "" {
		language = "English"
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

	// Prune massive arrays to save LLM context
	delete(telemetryMap, "ntc_compressed_files")
	cleanedTelemetryBytes, _ := json.Marshal(telemetryMap)
	telemetryForPrompt = string(cleanedTelemetryBytes)

	// Task 3: Strict Anti-Conversational Prompt
	var prompt string
	if imageBase64 != "" {
		prompt = fmt.Sprintf(`You are an expert 3D model analyst. I am providing you with a 2D rendering of a 3D scanned environment/object. Output EXACTLY 3 bullet points.
CRITICAL: You must write your entire response STRICTLY in %s.
CRITICAL: DO NOT start with "Sure, here are..." or any conversational text. You MUST start your response exactly with the first bullet point.
CRITICAL: Do NOT mention that this is an image, photograph, or render. Focus entirely on describing the physical 3D scene, space, objects, and textures.

- Object: [deduce name from file_path or prim_names]
- Visual: [briefly describe the 3D space, objects, and textures visible]
- %s

JSON DATA:
%s`, language, compressionStr, telemetryForPrompt)
	} else {
		prompt = fmt.Sprintf(`You are a robotic data formatter. Output EXACTLY 3 bullet points.
CRITICAL: You must write your entire response STRICTLY in %s.
CRITICAL: DO NOT start with "Sure, here are..." or any conversational text. You MUST start your response exactly with the first bullet point.

- Object: [deduce name from file_path or prim_names]
- Geometry: [total_vertices] vertices, [total_faces] faces
- %s

JSON DATA:
%s`, language, compressionStr, telemetryForPrompt)
	}

	reqBody := OllamaRequest{
		Model:   model,
		Prompt:  prompt,
		Stream:  true, // Switched to streaming
		Options: map[string]interface{}{"num_ctx": 16384},
	}

	if imageBase64 != "" {
		base64Data := imageBase64
		if idx := strings.Index(base64Data, ","); idx != -1 {
			base64Data = base64Data[idx+1:]
		}
		reqBody.Images = []string{base64Data}
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

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("local AI returned HTTP %d: %s", resp.StatusCode, trimForError(body))
	}

	scanner := bufio.NewScanner(resp.Body)
	var fullResponse strings.Builder

	for scanner.Scan() {
		line := scanner.Bytes()
		var ollamaResp OllamaResponse
		if err := json.Unmarshal(line, &ollamaResp); err == nil {
			fullResponse.WriteString(ollamaResp.Response)
			application.Get().Event.Emit("llmToken", ollamaResp.Response)
		}
	}

	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("failed reading stream: %v", err)
	}

	application.Get().Event.Emit("llmDone", fullResponse.String())
	return fullResponse.String(), nil
}

func normalizeAdvicePayload(payload string) (string, string, string, string) {
	model := "gemma:2b"
	context := "Default mesh analysis."
	telemetry := payload
	var imageBase64 string

	var structured AdvicePayload
	if err := json.Unmarshal([]byte(payload), &structured); err == nil {
		model = sanitizeOllamaModel(structured.Model)
		if len(structured.Telemetry) > 0 && string(structured.Telemetry) != "null" {
			telemetry = string(structured.Telemetry)
		} else if structured.RawTelemetry != "" {
			telemetry = structured.RawTelemetry
		}
		if language := strings.TrimSpace(structured.Language); language != "" {
			telemetry = injectAdviceLanguage(telemetry, language)
		}
		imageBase64 = structured.ImageBase64
		return model, telemetry, context, imageBase64
	}

	return model, telemetry, context, imageBase64
}

func injectAdviceLanguage(telemetry string, language string) string {
	var telemetryMap map[string]any
	if err := json.Unmarshal([]byte(telemetry), &telemetryMap); err != nil {
		return telemetry
	}

	telemetryMap["language"] = language
	normalizedTelemetry, err := json.Marshal(telemetryMap)
	if err != nil {
		return telemetry
	}

	return string(normalizedTelemetry)
}

func sanitizeOllamaModel(model string) string {
	switch strings.TrimSpace(model) {
	case "llama3", "llama3:8b":
		return "llama3"
	case "mistral", "mistral:7b":
		return "mistral"
	case "llava":
		return "llava"
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
func (a *App) ProcessModel(absolutePath string, bpp string, steps string) (string, error) {
	if absolutePath == "" {
		return "", fmt.Errorf("absolute path is empty")
	}

	if bpp == "" {
		return "", fmt.Errorf("bpp is empty")
	}

	if steps == "" {
		steps = "150"
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

	// 2. PRODUCTION PIPELINE: gRPC Call to Python Backend
	conn, err := grpc.NewClient("localhost:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return "", fmt.Errorf("failed to connect to gRPC server: %v", err)
	}
	defer conn.Close()

	client := pb.NewNtcPipelineServiceClient(conn)

	bppInt, _ := strconv.Atoi(bpp)
	stepsInt, _ := strconv.Atoi(steps)

	req := &pb.ProcessModelRequest{
		AbsolutePath:  absolutePath,
		TargetBitrate: int32(bppInt),
		TrainingSteps: int32(stepsInt),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	stream, err := client.ProcessModel(ctx, req)
	if err != nil {
		return "", fmt.Errorf("gRPC ProcessModel stream failed: %v", err)
	}

	var jsonResult string

	for {
		update, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("błąd strumieniowania gRPC: %v", err)
		}

		switch update.UpdateType {
		case "info":
			fmt.Println("[gRPC Stream]", update.Message)
			// Emit live log to frontend if you want to show it in the UI!
			application.Get().Event.Emit("pipelineLog", update.Message)
		case "error":
			return "", fmt.Errorf("pipeline error: %s", update.Message)
		case "result":
			jsonResult = update.TelemetryJson
		}
	}

	if jsonResult == "" || jsonResult == "{}" {
		return "", fmt.Errorf("pipeline executed successfully but returned no JSON telemetry")
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
