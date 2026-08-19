package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	pb "changeme/pipeline_rpc/pipeline"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// App struct manages the application logic
type App struct{}

// OllamaRequest represents the request payload for the Ollama API
type OllamaRequest struct {
	Model   string         `json:"model"`
	Prompt  string         `json:"prompt"`
	Stream  bool           `json:"stream"`
	Images  []string       `json:"images,omitempty"`
	Options map[string]any `json:"options,omitempty"`
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
		if files, ok := telemetryMap["ntc_compressed_files"].([]any); ok {
			var total float64
			var count int
			for _, f := range files {
				if fm, ok := f.(map[string]any); ok {
					if vramRed, ok := fm["vram_reduction"].(string); ok {
						vramRed = strings.ReplaceAll(vramRed, "%", "")
						if val, err := strconv.ParseFloat(vramRed, 64); err == nil {
							total += val
							count++
						}
					}
				}
			}
			if count > 0 {
				vramReductionStr = fmt.Sprintf("%.1f%%", total/float64(count))
			} else {
				vramReductionStr = "0%"
			}
		} else {
			vramReductionStr = "0%"
		}
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
		Options: map[string]any{
			"num_ctx": 16384,
			"temperature": 0.0,
		},
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
	var started bool

	for scanner.Scan() {
		line := scanner.Bytes()
		var ollamaResp OllamaResponse
		if err := json.Unmarshal(line, &ollamaResp); err == nil {
			token := ollamaResp.Response
			
			if !started {
				fullResponse.WriteString(token)
				currentStr := fullResponse.String()
				// Trim leading garbage (allow letters, numbers, dash, asterisk)
				trimmed := strings.TrimLeftFunc(currentStr, func(r rune) bool {
					return r != '-' && r != '*' && (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9')
				})
				if len(trimmed) > 0 {
					started = true
					fullResponse.Reset()
					fullResponse.WriteString(trimmed)
					application.Get().Event.Emit("llmToken", trimmed)
				}
			} else {
				fullResponse.WriteString(token)
				application.Get().Event.Emit("llmToken", token)
			}
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
	// Increased timeout to 15 minutes for all models to prevent context deadline exceeded
	return 15 * time.Minute
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

	// If we are given a .glb, check if a .usdz version exists alongside it (e.g. from Sketchfab download)
	ext := strings.ToLower(filepath.Ext(absolutePath))
	if ext == ".glb" || ext == ".gltf" {
		usdzPath := strings.TrimSuffix(absolutePath, ext) + ".usdz"
		if _, err := os.Stat(usdzPath); err == nil {
			// Found USDZ version, swap to it so we process it in Core instead of bypassing
			absolutePath = usdzPath
			ext = ".usdz"
		} else {
			// No USDZ found, standard WebGL proxy bypass
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

	// Connect to Python gRPC server (exposed via task run-core on port 50051)
	conn, err := grpc.NewClient("127.0.0.1:50051", 
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(100*1024*1024),
			grpc.MaxCallSendMsgSize(100*1024*1024),
		),
	)
	if err != nil {
		return "", fmt.Errorf("failed to connect to gRPC server: %v", err)
	}
	defer conn.Close()

	client := pb.NewNtcPipelineServiceClient(conn)

	bppInt, _ := strconv.Atoi(bpp)
	stepsInt, _ := strconv.Atoi(steps)

	fileName := filepath.Base(absolutePath)
	
	// Upload file to MinIO
	minioClient, err := minio.New("127.0.0.1:9000", &minio.Options{
		Creds:  credentials.NewStaticV4("admin", "Nequ3dSecureStore2026!", ""),
		Secure: false,
	})
	if err != nil {
		return "", fmt.Errorf("failed to init MinIO client: %v", err)
	}

	bucketName := "raw-scans"
	exists, errBucket := minioClient.BucketExists(context.Background(), bucketName)
	if errBucket == nil && !exists {
		err = minioClient.MakeBucket(context.Background(), bucketName, minio.MakeBucketOptions{})
		if err != nil {
			fmt.Printf("[Wails Backend] Warning: could not create bucket %s: %v\n", bucketName, err)
		} else {
			fmt.Printf("[Wails Backend] Created bucket %s\n", bucketName)
		}
	}

	exists, errBucket = minioClient.BucketExists(context.Background(), "processed-models")
	if errBucket == nil && !exists {
		err = minioClient.MakeBucket(context.Background(), "processed-models", minio.MakeBucketOptions{})
		if err != nil {
			fmt.Printf("[Wails Backend] Warning: could not create bucket processed-models: %v\n", err)
		} else {
			fmt.Printf("[Wails Backend] Created bucket processed-models\n")
		}
	}

	objectKey := fmt.Sprintf("%d-%s", time.Now().Unix(), fileName)
	
	fmt.Printf("[Wails Backend] Uploading %s to MinIO (bucket: %s, key: %s)...\n", fileName, bucketName, objectKey)
	_, err = minioClient.FPutObject(context.Background(), bucketName, objectKey, absolutePath, minio.PutObjectOptions{})
	if err != nil {
		return "", fmt.Errorf("failed to upload to MinIO: %v", err)
	}
	fmt.Printf("[Wails Backend] Upload to MinIO complete!\n")



	req := &pb.ProcessModelRequest{
		FileName:      fileName,
		S3ObjectKey:   objectKey,
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
			return "", fmt.Errorf("error receiving gRPC stream: %v", err)
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
			
			if update.ProxyGlbS3Key != "" {
				tempFile, err := os.CreateTemp("", "proxy_*.glb")
				if err == nil {
					tempFile.Close() // Close it so MinIO can write to it via FGetObject
					err = minioClient.FGetObject(context.Background(), "processed-models", update.ProxyGlbS3Key, tempFile.Name(), minio.GetObjectOptions{})
					if err == nil {
						var telemetryMap map[string]any
						if err := json.Unmarshal([]byte(jsonResult), &telemetryMap); err == nil {
							telemetryMap["proxy_glb_path"] = tempFile.Name()
							if updatedJson, err := json.Marshal(telemetryMap); err == nil {
								jsonResult = string(updatedJson)
							}
						}
					} else {
						fmt.Printf("[Wails Backend] Warning: failed to download proxy GLB from MinIO: %v\n", err)
					}
				}
			}
		}
	}

	if jsonResult == "" || jsonResult == "{}" {
		return "", fmt.Errorf("pipeline executed successfully but returned no JSON telemetry")
	}

	fmt.Printf("[Wails Backend] Successfully received telemetry for %s. Processing finished.\n", fileName)

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

// LocateObjects sends a snapshot and prompt to the Python Backend for object detection
func (a *App) LocateObjects(imageBase64 string, prompt string) (string, error) {
	conn, err := grpc.NewClient("nequ3d.local:80", 
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(100*1024*1024),
			grpc.MaxCallSendMsgSize(100*1024*1024),
		),
	)
	if err != nil {
		return "", fmt.Errorf("failed to connect to gRPC server: %v", err)
	}
	defer conn.Close()

	client := pb.NewNtcPipelineServiceClient(conn)

	// Remove data:image/png;base64, prefix if present
	idx := strings.Index(imageBase64, ",")
	if idx != -1 {
		imageBase64 = imageBase64[idx+1:]
	}

	imageData, err := base64.StdEncoding.DecodeString(imageBase64)
	if err != nil {
		return "", fmt.Errorf("failed to decode image base64: %v", err)
	}

	req := &pb.LocateRequest{
		ImageData: imageData,
		Prompt:    prompt,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	resp, err := client.LocateObjects(ctx, req)
	if err != nil {
		return "", fmt.Errorf("gRPC LocateObjects failed: %v", err)
	}

	jsonResp, err := json.Marshal(resp)
	if err != nil {
		return "", fmt.Errorf("failed to marshal response: %v", err)
	}

	return string(jsonResp), nil
}

func extractSketchfabUID(input string) string {
	if strings.Contains(input, "sketchfab.com/3d-models/") {
		parts := strings.Split(input, "-")
		if len(parts) > 0 {
			return parts[len(parts)-1]
		}
	}
	return input
}

func (a *App) DownloadFromSketchfab(uid string, token string) (string, error) {
	uid = extractSketchfabUID(uid)

	req, err := http.NewRequest("GET", "https://api.sketchfab.com/v3/models/"+uid+"/download", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Token "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to contact Sketchfab API: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("Sketchfab API error (%d): %s", resp.StatusCode, string(body))
	}

	var data struct {
		Usdz struct {
			Url string `json:"url"`
		} `json:"usdz"`
		Glb struct {
			Url string `json:"url"`
		} `json:"glb"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", fmt.Errorf("failed to parse Sketchfab response: %v", err)
	}

	if data.Usdz.Url == "" {
		return "", fmt.Errorf("Ten model nie posiada formatu USDZ (wymaganego przez NTC).")
	}
	if data.Glb.Url == "" {
		return "", fmt.Errorf("Ten model nie posiada formatu GLB (wymaganego do podglądu).")
	}

	downloadClient := &http.Client{Timeout: 5 * time.Minute}
	cwd, _ := os.Getwd()
	downloadsDir := filepath.Join(cwd, "..", "data", "downloads")
	os.MkdirAll(downloadsDir, 0755)

	// Download USDZ
	usdzReq, err := http.NewRequest("GET", data.Usdz.Url, nil)
	if err != nil { return "", err }
	usdzResp, err := downloadClient.Do(usdzReq)
	if err != nil { return "", fmt.Errorf("failed to download USDZ: %v", err) }
	defer usdzResp.Body.Close()
	
	if usdzResp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to download USDZ, status code: %d", usdzResp.StatusCode)
	}
	usdzPath := filepath.Join(downloadsDir, uid+".usdz")
	usdzOut, err := os.Create(usdzPath)
	if err != nil { return "", err }
	io.Copy(usdzOut, usdzResp.Body)
	usdzOut.Close()

	// Download GLB for Preview
	glbReq, err := http.NewRequest("GET", data.Glb.Url, nil)
	if err != nil { return "", err }
	glbResp, err := downloadClient.Do(glbReq)
	if err != nil { return "", fmt.Errorf("failed to download GLB: %v", err) }
	defer glbResp.Body.Close()

	if glbResp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to download GLB, status code: %d", glbResp.StatusCode)
	}
	glbPath := filepath.Join(downloadsDir, uid+".glb")
	glbOut, err := os.Create(glbPath)
	if err != nil { return "", err }
	io.Copy(glbOut, glbResp.Body)
	glbOut.Close()

	return glbPath, nil
}
