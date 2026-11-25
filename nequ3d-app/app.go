package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
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

	pb "changeme/pipeline_rpc/pipeline"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

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
	model, telemetryForPrompt, instructionCtx, imageBase64 := normalizeAdvicePayload(telemetryJSON)
	// Task 2: Pre-compute NTC logic in Go for the LLM
	var telemetryMap map[string]any
	if err := json.Unmarshal([]byte(telemetryForPrompt), &telemetryMap); err != nil {
		return "", fmt.Errorf("failed to unmarshal telemetry for advice: %v", err)
	}
	if telemetryMap == nil {
		telemetryMap = map[string]any{}
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

	isPolish := strings.EqualFold(language, "Polish") || strings.EqualFold(language, "pl")

	qualitySuffix := ""
	psnrVal, hasPsnr := telemetryMap["avg_psnr_db"].(float64)
	ssimVal, hasSsim := telemetryMap["avg_ssim"].(float64)
	if hasPsnr && psnrVal > 0 {
		if hasSsim && ssimVal > 0 {
			qualitySuffix = fmt.Sprintf(" (PSNR: %.2f dB, SSIM: %.4f)", psnrVal, ssimVal)
		} else {
			qualitySuffix = fmt.Sprintf(" (PSNR: %.2f dB)", psnrVal)
		}
	}

	var compressionStr string
	if isPolish {
		if ntcBypassed {
			compressionStr = "Kompresja NTC: Pominięta (brak oszczędności VRAM)."
		} else {
			compressionStr = "Kompresja NTC: Aktywna. Szacowana redukcja VRAM: " + vramReductionStr + qualitySuffix
		}
	} else {
		if ntcBypassed {
			compressionStr = "NTC Compression: Bypassed. No VRAM savings."
		} else {
			compressionStr = "NTC Compression: Active. Estimated VRAM Reduction: " + vramReductionStr + qualitySuffix
		}
	}

	// Extract exact telemetry values in Go so small local models (e.g. gemma:2b)
	// never swap vertices/faces/prims or hallucinate numbers from nested JSON.
	numVal := func(key string) int64 {
		switch v := telemetryMap[key].(type) {
		case float64:
			return int64(v)
		case int64:
			return v
		case int:
			return int64(v)
		}
		return 0
	}
	vertices := numVal("total_vertices")
	faces := numVal("total_faces")
	meshes := numVal("mesh_count")
	textures := numVal("texture_count")
	prims := numVal("total_prim_count")

	objectName := ""
	if src, ok := telemetryMap["source_asset"].(string); ok && strings.TrimSpace(src) != "" {
		objectName = filepath.Base(strings.ReplaceAll(src, "\\", "/"))
	} else if primNames, ok := telemetryMap["prim_names"].([]any); ok && len(primNames) > 0 {
		if first, ok := primNames[0].(string); ok {
			objectName = first
		}
	}
	if objectName == "" {
		objectName = "3D Asset"
	}

	formatInt := func(n int64, sep string) string {
		s := strconv.FormatInt(n, 10)
		if len(s) <= 3 {
			return s
		}
		var out []byte
		rem := len(s) % 3
		if rem > 0 {
			out = append(out, s[:rem]...)
		}
		for i := rem; i < len(s); i += 3 {
			if len(out) > 0 {
				out = append(out, sep...)
			}
			out = append(out, s[i:i+3]...)
		}
		return string(out)
	}
	plPlural := func(n int64, one, few, many string) string {
		abs := n
		if abs < 0 {
			abs = -abs
		}
		if abs == 1 {
			return one
		}
		mod10 := abs % 10
		mod100 := abs % 100
		if mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) {
			return few
		}
		return many
	}

	var geomLine string
	if isPolish {
		geomLine = fmt.Sprintf(
			"%s wierzchołków, %s wielokątów, %d %s i %d %s (%d elementów sceny)",
			formatInt(vertices, " "),
			formatInt(faces, " "),
			meshes, plPlural(meshes, "siatka", "siatki", "siatek"),
			textures, plPlural(textures, "tekstura", "tekstury", "tekstur"),
			prims,
		)
	} else {
		meshWord := "meshes"
		if meshes == 1 {
			meshWord = "mesh"
		}
		texWord := "textures"
		if textures == 1 {
			texWord = "texture"
		}
		geomLine = fmt.Sprintf(
			"%s vertices, %s faces, %d %s, and %d %s (%d scene prims)",
			formatInt(vertices, ","),
			formatInt(faces, ","),
			meshes, meshWord,
			textures, texWord,
			prims,
		)
	}

	hasExtraCtx := instructionCtx != "" && instructionCtx != "Default mesh analysis."
	var prompt string
	if isPolish {
		if imageBase64 != "" {
			prompt = fmt.Sprintf(`Jesteś przyjaznym doradcą technicznym Nequ3D. Na podstawie widoku 3D i poniższych faktów napisz zwięzłe, czytelne dla człowieka podsumowanie po polsku (dokładnie 3 krótkie punkty, zacznij od razu od "- ", bez wstępu i bez technicznego żargonu):

- **Obiekt:** %s — [jedno krótkie zdanie co widać w scenie 3D]
- **Złożoność modelu:** [naturalnym językiem opisz geometrię na podstawie: %s]
- **Pamięć VRAM:** [naturalnym językiem podsumuj: %s]`, objectName, geomLine, compressionStr)
		} else if hasExtraCtx && strings.Contains(instructionCtx, "twin_manifest") {
			prompt = fmt.Sprintf(`Jesteś przyjaznym asystentem inwentaryzacji 3D w Nequ3D. Napisz przejrzyste, naturalne podsumowanie dla człowieka po polsku (dokładnie 4 krótkie punkty, zacznij od razu od "- ", bez wstępu; zachowaj dokładne liczby z danych):

- **Model:** %s (%s)
- **Kompresja tekstur:** [jednym przystępnym zdaniem wyjaśnij korzyść z: %s]
- **Wykryte strefy:** [czytelnie nazwij strefy z kontekstu poniżej i ich status]
- **Kolejny krok:** [jedno praktyczne zdanie, co warto oznaczyć lub zmierzyć przed remontem]

KONTEKST STREF:
%s`, objectName, geomLine, compressionStr, instructionCtx)
		} else {
			prompt = fmt.Sprintf(`Jesteś przyjaznym doradcą technicznym Nequ3D. Napisz zwięzłe, naturalne podsumowanie skanu 3D dla użytkownika po polsku (dokładnie 3 krótkie punkty, zacznij od razu od "- ", bez wstępu; zachowaj dokładne liczby):

- **Model:** %s — [jedno krótkie zdanie o charakterze tego skanu]
- **Geometria:** %s
- **Pamięć VRAM:** [przystępnym zdaniem podsumuj: %s]`, objectName, geomLine, compressionStr)
		}
	} else {
		if imageBase64 != "" {
			prompt = fmt.Sprintf(`You are a helpful Nequ3D technical advisor. Write a clear, human-friendly summary in English (exact 3 short bullets, start immediately with "- ", no intro):

- **Model:** %s — [one brief sentence describing the 3D scene]
- **Geometry:** [summarize cleanly in plain language: %s]
- **VRAM savings:** [plain-language summary of: %s]`, objectName, geomLine, compressionStr)
		} else if hasExtraCtx && strings.Contains(instructionCtx, "twin_manifest") {
			prompt = fmt.Sprintf(`You are a friendly 3D building renovation assistant in Nequ3D. Write a clear, readable summary in English (exact 4 short bullets, start immediately with "- ", no intro; keep the exact numbers):

- **Model:** %s (%s)
- **Texture optimization:** [one friendly sentence explaining the benefit of: %s]
- **Building zones:** [summarize the zones and their current status cleanly]
- **Next step:** [one practical tip for marking or measuring zones before renovation]

ZONE CONTEXT:
%s`, objectName, geomLine, compressionStr, instructionCtx)
		} else {
			prompt = fmt.Sprintf(`You are a helpful Nequ3D technical advisor. Write a clear, human-friendly summary in English (exact 3 short bullets, start immediately with "- ", no intro; keep exact numbers):

- **Model:** %s — [one concise sentence about this 3D asset]
- **Geometry:** %s
- **VRAM savings:** [one friendly sentence summarizing: %s]`, objectName, geomLine, compressionStr)
		}
	}

	reqBody := OllamaRequest{
		Model:  model,
		Prompt: prompt,
		Stream: true, // Switched to streaming
		Options: map[string]any{
			"num_ctx":     16384,
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

	cleaned := stripConversationalPreamble(fullResponse.String())
	application.Get().Event.Emit("llmDone", cleaned)
	return cleaned, nil
}

func stripConversationalPreamble(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
		return trimmed
	}
	lines := strings.Split(trimmed, "\n")
	for i, line := range lines {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "- ") || strings.HasPrefix(l, "* ") || strings.HasPrefix(l, "• ") {
			return strings.TrimSpace(strings.Join(lines[i:], "\n"))
		}
	}
	return trimmed
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
		if trimmedCtx := strings.TrimSpace(structured.InstructionContext); trimmedCtx != "" {
			context = trimmedCtx
		}
		if model == "llava" {
			imageBase64 = structured.ImageBase64
		}
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
	go func() {
		var lastGPU, lastVRAM float64 = -1, -1
		var lastAvailable = true
		var lastEmit time.Time

		maybeEmit := func(s SystemStats) {
			gpuChanged := mathAbs(s.GPU-lastGPU) >= 0.2 || mathAbs(s.VRAM-lastVRAM) >= 0.2 || s.Available != lastAvailable
			if !gpuChanged && time.Since(lastEmit) < 10*time.Second {
				return
			}
			lastGPU, lastVRAM, lastAvailable = s.GPU, s.VRAM, s.Available
			lastEmit = time.Now()
			app.Event.Emit("sysStats", s)
		}

		// Try persistent single-process nvidia-smi stream (-lms 2500) to avoid spawning OS processes every second.
		cmd := exec.Command(
			"nvidia-smi",
			"--query-gpu=utilization.gpu,memory.used,memory.total",
			"--format=csv,noheader,nounits",
			"-lms", "2500",
		)
		configureBackgroundCommand(cmd)
		stdout, err := cmd.StdoutPipe()
		if err == nil && cmd.Start() == nil {
			scanner := bufio.NewScanner(stdout)
			for scanner.Scan() {
				maybeEmit(parseNVIDIACSVLine(scanner.Text()))
			}
			_ = cmd.Wait()
		}

		// Fallback polling (e.g. if nvidia-smi is unavailable on machine)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			maybeEmit(queryNVIDIAStats())
			<-ticker.C
		}
	}()
}

func mathAbs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func parseNVIDIACSVLine(line string) SystemStats {
	stats := SystemStats{Time: time.Now().Format("15:04:05")}
	parts := strings.Split(strings.TrimSpace(line), ",")
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

func queryNVIDIAStats() SystemStats {
	stats := SystemStats{Time: time.Now().Format("15:04:05")}
	cmd := exec.Command(
		"nvidia-smi",
		"--query-gpu=utilization.gpu,memory.used,memory.total",
		"--format=csv,noheader,nounits",
	)
	configureBackgroundCommand(cmd)
	output, err := cmd.Output()

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
	previews.register(absolutePath)
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

	tStart := time.Now()
	rootCtx, rootSpan := edgeTracer().Start(context.Background(), "nequ3d.edge.process_model")
	defer rootSpan.End()
	traceID := rootSpan.SpanContext().TraceID().String()
	edgeTimings := map[string]float64{}

	// Connect to Python gRPC server (exposed via task run-core on port 50051)
	conn, err := grpc.NewClient(coreAddress(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(100*1024*1024),
			grpc.MaxCallSendMsgSize(100*1024*1024),
		),
	)
	if err != nil {
		rootSpan.RecordError(err)
		rootSpan.SetStatus(codes.Error, err.Error())
		return "", fmt.Errorf("failed to connect to gRPC server: %v", err)
	}
	defer conn.Close()

	client := pb.NewNtcPipelineServiceClient(conn)

	bppInt, _ := strconv.Atoi(bpp)
	stepsInt, _ := strconv.Atoi(steps)
	fileName := filepath.Base(absolutePath)
	rootSpan.SetAttributes(
		attribute.String("nequ3d.asset.name", fileName),
		attribute.Int("nequ3d.ntc.bpp", bppInt),
		attribute.Int("nequ3d.ntc.steps", stepsInt),
	)

	// The launcher inherits these credentials from the Kubernetes secret.
	accessKey, secretKey := os.Getenv("MINIO_ACCESS_KEY"), os.Getenv("MINIO_SECRET_KEY")
	if accessKey == "" || secretKey == "" {
		return "", fmt.Errorf("missing MINIO_ACCESS_KEY/MINIO_SECRET_KEY; use task run-all or configure the environment")
	}
	endpoint := os.Getenv("NEQU3D_MINIO_ENDPOINT")
	if endpoint == "" {
		endpoint = "127.0.0.1:9000"
	}
	minioClient, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: false,
	})
	if err != nil {
		rootSpan.RecordError(err)
		return "", fmt.Errorf("failed to init MinIO client: %v", err)
	}

	bucketName := "raw-scans"
	exists, errBucket := minioClient.BucketExists(rootCtx, bucketName)
	if errBucket == nil && !exists {
		err = minioClient.MakeBucket(rootCtx, bucketName, minio.MakeBucketOptions{})
		if err != nil {
			fmt.Printf("[Wails Backend] Warning: could not create bucket %s: %v\n", bucketName, err)
		} else {
			fmt.Printf("[Wails Backend] Created bucket %s\n", bucketName)
		}
	}

	exists, errBucket = minioClient.BucketExists(rootCtx, "processed-models")
	if errBucket == nil && !exists {
		err = minioClient.MakeBucket(rootCtx, "processed-models", minio.MakeBucketOptions{})
		if err != nil {
			fmt.Printf("[Wails Backend] Warning: could not create bucket processed-models: %v\n", err)
		} else {
			fmt.Printf("[Wails Backend] Created bucket processed-models\n")
		}
	}

	objectKey := fmt.Sprintf("%s-%s", rand.Text(), fileName)

	tSha := time.Now()
	_, shaSpan := edgeTracer().Start(rootCtx, "nequ3d.edge.integrity_sha256")
	sourceDigest, err := writeIntegritySidecar(absolutePath, map[string]any{
		"kind":   "edge_upload",
		"bucket": bucketName,
		"key":    objectKey,
	})
	shaSpan.End()
	edgeTimings["sha256_ms"] = float64(time.Since(tSha).Microseconds()) / 1000.0
	if err != nil {
		fmt.Printf("[Wails Backend] Warning: integrity sidecar failed: %v\n", err)
	} else {
		fmt.Printf("[Wails Backend] Source SHA-256: %s\n", sourceDigest)
	}

	fmt.Printf("[Wails Backend] Uploading %s to MinIO (bucket: %s, key: %s)...\n", fileName, bucketName, objectKey)
	putOpts := minio.PutObjectOptions{
		UserMetadata: map[string]string{
			"sha256":          sourceDigest,
			"nequ3d-pipeline": "building-renovation-twin",
			"trace-id":        traceID,
		},
	}
	tUp := time.Now()
	_, upSpan := edgeTracer().Start(rootCtx, "nequ3d.edge.minio_upload")
	upSpan.SetAttributes(attribute.String("s3.bucket", bucketName), attribute.String("s3.key", objectKey))
	// Prefer bucket-default SSE-S3 / KMS on MinIO (see gitops/apps/minio-standalone.yaml).
	_, err = minioClient.FPutObject(rootCtx, bucketName, objectKey, absolutePath, putOpts)
	upSpan.End()
	edgeTimings["minio_upload_ms"] = float64(time.Since(tUp).Microseconds()) / 1000.0
	if err != nil {
		rootSpan.RecordError(err)
		rootSpan.SetStatus(codes.Error, err.Error())
		return "", fmt.Errorf("failed to upload to MinIO: %v", err)
	}
	fmt.Printf("[Wails Backend] Upload to MinIO complete!\n")

	req := &pb.ProcessModelRequest{
		FileName:      fileName,
		S3ObjectKey:   objectKey,
		TargetBitrate: int32(bppInt),
		TrainingSteps: int32(stepsInt),
	}

	tRpc := time.Now()
	rpcSpanCtx, rpcSpan := edgeTracer().Start(rootCtx, "nequ3d.edge.core_grpc_stream")
	ctx, cancel := context.WithTimeout(injectTraceMetadata(rpcSpanCtx), 15*time.Minute)
	defer cancel()

	stream, err := client.ProcessModel(ctx, req)
	if err != nil {
		rpcSpan.RecordError(err)
		rpcSpan.End()
		rootSpan.SetStatus(codes.Error, err.Error())
		return "", fmt.Errorf("gRPC ProcessModel stream failed: %v", err)
	}

	var jsonResult string

	for {
		update, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			rpcSpan.RecordError(err)
			rpcSpan.End()
			rootSpan.SetStatus(codes.Error, err.Error())
			return "", fmt.Errorf("error receiving gRPC stream: %v", err)
		}

		switch update.UpdateType {
		case "info":
			fmt.Println("[gRPC Stream]", update.Message)
			application.Get().Event.Emit("pipelineLog", update.Message)
		case "error":
			rpcSpan.End()
			rootSpan.SetStatus(codes.Error, update.Message)
			return "", fmt.Errorf("pipeline error: %s", update.Message)
		case "result":
			edgeTimings["core_rpc_ms"] = float64(time.Since(tRpc).Microseconds()) / 1000.0
			jsonResult = update.TelemetryJson

			if update.ProxyGlbS3Key != "" {
				tDl := time.Now()
				_, dlSpan := edgeTracer().Start(rootCtx, "nequ3d.edge.minio_download_proxy")
				tempFile, err := os.CreateTemp("", "proxy_*.glb")
				if err == nil {
					tempFile.Close()
					err = minioClient.FGetObject(rootCtx, "processed-models", update.ProxyGlbS3Key, tempFile.Name(), minio.GetObjectOptions{})
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
				dlSpan.End()
				edgeTimings["minio_download_ms"] = float64(time.Since(tDl).Microseconds()) / 1000.0
			}

			jsonResult = remapTwinPathsForHost(jsonResult)
		}
	}
	rpcSpan.End()

	if jsonResult == "" || jsonResult == "{}" {
		return "", fmt.Errorf("pipeline executed successfully but returned no JSON telemetry")
	}

	edgeTimings["total_ms"] = float64(time.Since(tStart).Microseconds()) / 1000.0
	jsonResult = enrichTelemetryWithTrace(jsonResult, traceID, edgeTimings)
	rootSpan.SetStatus(codes.Ok, "completed")

	fmt.Printf("[Wails Backend] Successfully received telemetry for %s. Processing finished.\n", fileName)

	previews.registerTelemetry(jsonResult)
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

func enrichTelemetryWithTrace(telemetryJSON string, traceID string, edgeTimings map[string]float64) string {
	var m map[string]any
	if err := json.Unmarshal([]byte(telemetryJSON), &m); err != nil || m == nil {
		return telemetryJSON
	}
	if traceID != "" && traceID != "00000000000000000000000000000000" {
		m["trace_id"] = traceID
		m["jaeger_url"] = jaegerTraceURL(traceID)
	}
	if len(edgeTimings) > 0 {
		rounded := make(map[string]float64, len(edgeTimings))
		for k, v := range edgeTimings {
			rounded[k] = float64(int64(v*10+0.5)) / 10.0
		}
		m["edge_timings_ms"] = rounded
	}
	out, err := json.Marshal(m)
	if err != nil {
		return telemetryJSON
	}
	return string(out)
}

// remapTwinPathsForHost rewrites Core container twin paths to the Windows workspace mount.
func remapTwinPathsForHost(telemetryJSON string) string {
	var telemetryMap map[string]any
	if err := json.Unmarshal([]byte(telemetryJSON), &telemetryMap); err != nil {
		return telemetryJSON
	}
	hostRoot := os.Getenv("NEQU3D_HOST_WORKSPACE")
	if hostRoot == "" {
		// Launcher mounts repo data/objects → /tmp/workspace
		cwd, _ := os.Getwd()
		hostRoot = filepath.Clean(filepath.Join(cwd, "..", "data", "objects"))
	}
	containerRoot := "/tmp/workspace"
	keys := []string{"twin_dir", "twin_manifest_path", "annotations_usda", "composed_usda", "omniverse_export_dir"}
	changed := false
	for _, key := range keys {
		v, _ := telemetryMap[key].(string)
		if v == "" {
			continue
		}
		if strings.HasPrefix(v, containerRoot) {
			rel := strings.TrimPrefix(v, containerRoot)
			rel = strings.TrimPrefix(rel, "/")
			rel = strings.ReplaceAll(rel, "/", string(filepath.Separator))
			telemetryMap[key] = filepath.Join(hostRoot, rel)
			changed = true
		}
	}
	if !changed {
		return telemetryJSON
	}
	out, err := json.Marshal(telemetryMap)
	if err != nil {
		return telemetryJSON
	}
	return string(out)
}

// SelectFile prompts the user with a system dialog to pick a 3D asset
func (a *App) SelectFile() (string, error) {
	path, err := application.Get().Dialog.OpenFile().
		SetTitle("Nequ3D: Select OpenUSD Asset").
		AddFilter("Nequ3D Assets", "*.usd;*.usdc;*.usda;*.usdz;*.glb;*.gltf;*.splat;*.ply").
		AddFilter("OpenUSD", "*.usd;*.usdc;*.usda;*.usdz").
		AddFilter("WebGL Mesh Proxy", "*.glb;*.gltf").
		AddFilter("Gaussian Splats", "*.splat;*.ply").
		AddFilter("All Files", "*.*").
		PromptForSingleSelection()

	if err != nil {
		return "", fmt.Errorf("dialog error: %v", err)
	}

	previews.register(path)
	return path, nil
}

// LocateObjects sends a snapshot and prompt to the Python Backend for object detection
func (a *App) LocateObjects(imageBase64 string, prompt string) (string, error) {
	conn, err := grpc.NewClient(coreAddress(),
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

	ctx, locateSpan := edgeTracer().Start(ctx, "nequ3d.edge.locate_objects",
		trace.WithAttributes(attribute.String("nequ3d.prompt", prompt)),
	)
	defer locateSpan.End()

	resp, err := client.LocateObjects(injectTraceMetadata(ctx), req)
	if err != nil {
		locateSpan.RecordError(err)
		locateSpan.SetStatus(codes.Error, err.Error())
		return "", fmt.Errorf("gRPC LocateObjects failed: %v (is LocateAnything on :8000? start with: pwsh -File ./scripts/run-all.ps1 -WithLocate)", err)
	}

	jsonResp, err := json.Marshal(resp)
	if err != nil {
		return "", fmt.Errorf("failed to marshal response: %v", err)
	}

	return string(jsonResp), nil
}

// Sketchfab error codes understood by the frontend i18n layer.
// The frontend maps these to localized, user-friendly messages.
const (
	ErrSketchfabNetwork    = "SKETCHFAB_NETWORK"
	ErrSketchfabRequest    = "SKETCHFAB_REQUEST"
	ErrSketchfabInvalidTok = "SKETCHFAB_INVALID_TOKEN"
	ErrSketchfabForbidden  = "SKETCHFAB_FORBIDDEN"
	ErrSketchfabNotFound   = "SKETCHFAB_NOT_FOUND"
	ErrSketchfabRateLimit  = "SKETCHFAB_RATE_LIMIT"
	ErrSketchfabServer     = "SKETCHFAB_SERVER"
	ErrSketchfabParse      = "SKETCHFAB_PARSE"
	ErrSketchfabNoUsdz     = "SKETCHFAB_NO_USDZ"
	ErrSketchfabNoGlb      = "SKETCHFAB_NO_GLB"
	ErrSketchfabDownload   = "SKETCHFAB_DOWNLOAD"
)

// sketchfabErr wraps an error with a stable machine-readable code that the
// frontend can translate into the user's current language.
type sketchfabErr struct {
	Code string
	Msg  string
}

func (e *sketchfabErr) Error() string { return e.Code + ": " + e.Msg }

// statusToSketchfabCode maps a Sketchfab HTTP status to a stable error code.
func statusToSketchfabCode(status int) string {
	switch status {
	case http.StatusUnauthorized:
		return ErrSketchfabInvalidTok
	case http.StatusForbidden:
		return ErrSketchfabForbidden
	case http.StatusNotFound:
		return ErrSketchfabNotFound
	case http.StatusTooManyRequests:
		return ErrSketchfabRateLimit
	case 500, 502, 503, 504:
		return ErrSketchfabServer
	default:
		return ErrSketchfabRequest
	}
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
		return "", &sketchfabErr{Code: ErrSketchfabRequest, Msg: err.Error()}
	}
	req.Header.Set("Authorization", "Token "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", &sketchfabErr{Code: ErrSketchfabNetwork, Msg: err.Error()}
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		// Respect the Sketchfab detail (e.g. "You do not have permission...")
		// but let the frontend decide the user-facing text.
		detail := parseSketchfabDetail(body)
		resp.Body.Close()
		return "", &sketchfabErr{Code: statusToSketchfabCode(resp.StatusCode), Msg: detail}
	}
	defer resp.Body.Close()

	var data struct {
		Usdz struct {
			Url string `json:"url"`
		} `json:"usdz"`
		Glb struct {
			Url string `json:"url"`
		} `json:"glb"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", &sketchfabErr{Code: ErrSketchfabParse, Msg: err.Error()}
	}

	if data.Usdz.Url == "" {
		return "", &sketchfabErr{Code: ErrSketchfabNoUsdz, Msg: "no USDZ"}
	}
	if data.Glb.Url == "" {
		return "", &sketchfabErr{Code: ErrSketchfabNoGlb, Msg: "no GLB"}
	}

	downloadClient := &http.Client{Timeout: 5 * time.Minute}
	cwd, _ := os.Getwd()
	downloadsDir := filepath.Join(cwd, "..", "data", "downloads")
	os.MkdirAll(downloadsDir, 0755)

	// Download USDZ
	usdzReq, err := http.NewRequest("GET", data.Usdz.Url, nil)
	if err != nil {
		return "", &sketchfabErr{Code: ErrSketchfabDownload, Msg: err.Error()}
	}
	usdzResp, err := downloadClient.Do(usdzReq)
	if err != nil {
		return "", &sketchfabErr{Code: ErrSketchfabDownload, Msg: err.Error()}
	}
	defer usdzResp.Body.Close()

	if usdzResp.StatusCode != http.StatusOK {
		return "", &sketchfabErr{Code: ErrSketchfabDownload, Msg: fmt.Sprintf("USDZ status %d", usdzResp.StatusCode)}
	}
	usdzPath := filepath.Join(downloadsDir, uid+".usdz")
	usdzOut, err := os.Create(usdzPath)
	if err != nil {
		return "", &sketchfabErr{Code: ErrSketchfabDownload, Msg: err.Error()}
	}
	io.Copy(usdzOut, usdzResp.Body)
	usdzOut.Close()

	// Download GLB for Preview
	glbReq, err := http.NewRequest("GET", data.Glb.Url, nil)
	if err != nil {
		return "", &sketchfabErr{Code: ErrSketchfabDownload, Msg: err.Error()}
	}
	glbResp, err := downloadClient.Do(glbReq)
	if err != nil {
		return "", &sketchfabErr{Code: ErrSketchfabDownload, Msg: err.Error()}
	}
	defer glbResp.Body.Close()

	if glbResp.StatusCode != http.StatusOK {
		return "", &sketchfabErr{Code: ErrSketchfabDownload, Msg: fmt.Sprintf("GLB status %d", glbResp.StatusCode)}
	}
	glbPath := filepath.Join(downloadsDir, uid+".glb")
	glbOut, err := os.Create(glbPath)
	if err != nil {
		return "", &sketchfabErr{Code: ErrSketchfabDownload, Msg: err.Error()}
	}
	io.Copy(glbOut, glbResp.Body)
	glbOut.Close()

	previews.register(glbPath)
	return glbPath, nil
}

// parseSketchfabDetail extracts the human-readable "detail" field from a
// Sketchfab error JSON body, falling back to the raw body when absent.
func parseSketchfabDetail(body []byte) string {
	var v struct {
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(body, &v); err == nil && v.Detail != "" {
		return v.Detail
	}
	// Sketchfab sometimes returns an HTML error page instead of JSON.
	// Do not leak raw HTML to the user — return a neutral fallback.
	t := bytes.TrimSpace(body)
	if len(t) > 0 && t[0] == '<' {
		return "Sketchfab returned an HTML error page"
	}
	return string(body)
}
