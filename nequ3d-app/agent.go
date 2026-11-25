package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"go.opentelemetry.io/otel/attribute"
)

type agentRequest struct {
	Goal         string `json:"goal"`
	Model        string `json:"model"`
	Language     string `json:"language"`
	AssetPath    string `json:"asset_path"`
	Bpp          string `json:"bpp"`
	Steps        string `json:"steps"`
	Telemetry    string `json:"telemetry"`
	ImageBase64  string `json:"image_base64"`
	LocatePrompt string `json:"locate_prompt"`
}

type agentStep struct {
	Tool    string `json:"tool"`
	Status  string `json:"status"`
	Detail  string `json:"detail"`
	Payload any    `json:"payload,omitempty"`
}

type agentPlan struct {
	Tools []string `json:"tools"`
}

// RunRenovationAgent executes a local tool-using renovation workflow via Ollama planning + Go tools.
func (a *App) RunRenovationAgent(requestJSON string) (string, error) {
	_, agentSpan := edgeTracer().Start(context.Background(), "nequ3d.edge.renovation_agent")
	defer agentSpan.End()

	var req agentRequest
	if err := json.Unmarshal([]byte(requestJSON), &req); err != nil {
		return "", fmt.Errorf("invalid agent request: %w", err)
	}
	if req.Goal == "" {
		req.Goal = "Analyze the building scan for renovation priorities by zone."
	}
	if req.Language == "" {
		req.Language = "English"
	}
	if req.Bpp == "" {
		req.Bpp = "5"
	}
	if req.Steps == "" {
		req.Steps = "150"
	}
	hasLocatePrompt := strings.TrimSpace(req.LocatePrompt) != ""
	if !hasLocatePrompt {
		req.LocatePrompt = "damaged wall, crack, moisture stain, window, door"
	}

	emit := func(step agentStep) {
		if raw, err := json.Marshal(step); err == nil {
			application.Get().Event.Emit("agentStep", string(raw))
		}
	}

	plannedTools, err := a.planAgentTools(req)
	if err != nil {
		emit(agentStep{Tool: "plan", Status: "error", Detail: err.Error()})
	}
	tools := normalizeAgentPlan(plannedTools, req, hasLocatePrompt)
	agentSpan.SetAttributes(
		attribute.String("nequ3d.agent.model", sanitizeOllamaModel(req.Model)),
		attribute.StringSlice("nequ3d.agent.tools", tools),
	)
	emit(agentStep{Tool: "plan", Status: "ok", Detail: strings.Join(tools, ","), Payload: tools})

	telemetry := strings.TrimSpace(req.Telemetry)
	var locateResult string
	var manifestSummary any
	var advice string

	for _, tool := range tools {
		switch strings.ToLower(strings.TrimSpace(tool)) {
		case "process_model":
			if req.AssetPath == "" {
				emit(agentStep{Tool: tool, Status: "skipped", Detail: "no asset_path"})
				continue
			}
			emit(agentStep{Tool: tool, Status: "running", Detail: filepath.Base(req.AssetPath)})
			out, err := a.ProcessModel(req.AssetPath, req.Bpp, req.Steps)
			if err != nil {
				emit(agentStep{Tool: tool, Status: "error", Detail: err.Error()})
				return "", err
			}
			telemetry = out
			emit(agentStep{Tool: tool, Status: "ok", Detail: "pipeline finished"})
		case "read_manifest":
			emit(agentStep{Tool: tool, Status: "running", Detail: "twin_manifest"})
			summary, err := summarizeTwinFromTelemetry(telemetry)
			if err != nil {
				emit(agentStep{Tool: tool, Status: "error", Detail: err.Error()})
			} else {
				manifestSummary = summary
				emit(agentStep{Tool: tool, Status: "ok", Detail: "manifest loaded", Payload: summary})
			}
		case "locate_objects":
			if req.ImageBase64 == "" {
				emit(agentStep{Tool: tool, Status: "skipped", Detail: "no image"})
				continue
			}
			emit(agentStep{Tool: tool, Status: "running", Detail: req.LocatePrompt})
			out, err := a.LocateObjects(req.ImageBase64, req.LocatePrompt)
			if err != nil {
				emit(agentStep{Tool: tool, Status: "error", Detail: err.Error()})
			} else {
				locateResult = out
				emit(agentStep{Tool: tool, Status: "ok", Detail: "detections ready"})
			}
		case "advice", "generate_advice":
			emit(agentStep{Tool: tool, Status: "running", Detail: "ollama"})
			adviceTelemetry := json.RawMessage("{}")
			if telemetry != "" {
				adviceTelemetry = json.RawMessage(preferRawJSON(telemetry))
			}
			advicePayload := map[string]any{
				"model":     sanitizeOllamaModel(req.Model),
				"language":  req.Language,
				"telemetry": adviceTelemetry,
			}
			if sanitizeOllamaModel(req.Model) == "llava" && req.ImageBase64 != "" {
				advicePayload["image_base64"] = req.ImageBase64
			}
			var ctxParts []string
			if manifestSummary != nil {
				var zoneSummary any = manifestSummary
				if m, ok := manifestSummary.(map[string]any); ok {
					zoneSummary = map[string]any{
						"zones":      m["zones"],
						"zone_count": m["zone_count"],
						"prim_count": m["prim_count"],
					}
				}
				if rawZones, err := json.Marshal(zoneSummary); err == nil {
					ctxParts = append(ctxParts, "Use building zones from twin_manifest when prioritizing renovation: "+string(rawZones))
				}
			}
			if locateResult != "" && locateResult != "null" {
				ctxParts = append(ctxParts, "Locate detections: "+locateResult)
			}
			if len(ctxParts) > 0 {
				advicePayload["instruction_context"] = strings.Join(ctxParts, "\n")
			}
			body, _ := json.Marshal(advicePayload)
			out, err := a.GenerateRenovationAdvice(string(body))
			if err != nil {
				// Keep the agent usable when Ollama is offline (common on first demo).
				offline := buildOfflineAdvice(req, telemetry, manifestSummary, locateResult)
				emit(agentStep{Tool: tool, Status: "ok", Detail: "offline fallback (Ollama unavailable)", Payload: err.Error()})
				advice = offline
				application.Get().Event.Emit("llmDone", offline)
			} else {
				advice = out
				emit(agentStep{Tool: tool, Status: "ok", Detail: "advice ready"})
			}
		case "save_annotations":
			emit(agentStep{Tool: tool, Status: "skipped", Detail: "UI owns SaveTwinAnnotations"})
		default:
			emit(agentStep{Tool: tool, Status: "skipped", Detail: "unknown tool"})
		}
	}

	result, _ := json.Marshal(map[string]any{
		"status":            "ok",
		"tools":             tools,
		"telemetry":         json.RawMessage(preferRawJSON(telemetry)),
		"manifest_summary":  manifestSummary,
		"locate":            json.RawMessage(preferRawJSON(locateResult)),
		"advice":            advice,
		"completed_at":      time.Now().UTC().Format(time.RFC3339),
	})
	application.Get().Event.Emit("agentDone", string(result))
	return string(result), nil
}

func normalizeAgentPlan(raw []string, req agentRequest, hasLocatePrompt bool) []string {
	hasTelemetry := strings.TrimSpace(req.Telemetry) != ""
	hasAsset := strings.TrimSpace(req.AssetPath) != ""
	wantLocate := false
	for _, t := range raw {
		if strings.EqualFold(strings.TrimSpace(t), "locate_objects") {
			wantLocate = true
			break
		}
	}

	var normalized []string
	if !hasTelemetry && hasAsset {
		normalized = append(normalized, "process_model")
	}
	normalized = append(normalized, "read_manifest")
	if wantLocate && hasLocatePrompt && req.ImageBase64 != "" {
		normalized = append(normalized, "locate_objects")
	}
	normalized = append(normalized, "advice")
	return normalized
}

func (a *App) planAgentTools(req agentRequest) ([]string, error) {
	model := sanitizeOllamaModel(req.Model)
	prompt := fmt.Sprintf(`You are a renovation digital-twin planner. Reply with ONLY JSON: {"tools":["..."]}.
Allowed tools: process_model, read_manifest, locate_objects, advice, save_annotations.
Goal: %s
Has asset_path: %t
Has telemetry: %t
Has image: %t
Language: %s
Prefer the minimal useful sequence.`, req.Goal, req.AssetPath != "", req.Telemetry != "", req.ImageBase64 != "", req.Language)

	body, _ := json.Marshal(OllamaRequest{
		Model:  model,
		Prompt: prompt,
		Stream: false,
		Options: map[string]any{
			"temperature": 0.0,
			"num_ctx":     4096,
		},
	})
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Post("http://localhost:11434/api/generate", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ollama plan HTTP %d: %s", resp.StatusCode, trimForError(b))
	}
	var ollamaResp OllamaResponse
	if err := json.NewDecoder(resp.Body).Decode(&ollamaResp); err != nil {
		return nil, err
	}
	text := strings.TrimSpace(ollamaResp.Response)
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("no JSON plan in model response")
	}
	var plan agentPlan
	if err := json.Unmarshal([]byte(text[start:end+1]), &plan); err != nil {
		return nil, err
	}
	if len(plan.Tools) == 0 {
		return nil, fmt.Errorf("empty tool plan")
	}
	return plan.Tools, nil
}

func preferRawJSON(s string) []byte {
	if s == "" {
		return []byte("null")
	}
	if json.Valid([]byte(s)) {
		return []byte(s)
	}
	b, _ := json.Marshal(s)
	return b
}

func buildOfflineAdvice(req agentRequest, telemetry string, manifestSummary any, locateResult string) string {
	var b strings.Builder
	if strings.EqualFold(req.Language, "Polish") || strings.EqualFold(req.Language, "pl") {
		b.WriteString("## Raport remontowy (tryb offline — Ollama niedostępna)\n\n")
		b.WriteString("1. Uruchom lokalnie: `ollama serve` oraz `ollama pull gemma:2b`.\n")
		b.WriteString("2. Przejrzyj strefy w twin_manifest i ustaw status (ok / replace).\n")
		b.WriteString("3. Użyj pomiarów i Locate in view do priorytetyzacji uszkodzeń.\n\n")
	} else {
		b.WriteString("## Renovation report (offline — Ollama unavailable)\n\n")
		b.WriteString("1. Start local AI: `ollama serve` then `ollama pull gemma:2b`.\n")
		b.WriteString("2. Review building zones in twin_manifest and set status (ok / replace).\n")
		b.WriteString("3. Use measurements and Locate in view to prioritize damage.\n\n")
	}
	if req.Goal != "" {
		b.WriteString("**Goal:** ")
		b.WriteString(req.Goal)
		b.WriteString("\n\n")
	}
	if manifestSummary != nil {
		raw, _ := json.MarshalIndent(manifestSummary, "", "  ")
		b.WriteString("### Twin summary\n```json\n")
		b.Write(raw)
		b.WriteString("\n```\n\n")
	}
	if telemetry != "" {
		b.WriteString("### Pipeline telemetry present\n")
		b.WriteString("NTC/mesh metrics are available in the left panel; export Omniverse layers from twin_dir when ready.\n\n")
	}
	if locateResult != "" && locateResult != "null" {
		b.WriteString("### Locate detections\n```json\n")
		b.WriteString(locateResult)
		b.WriteString("\n```\n")
	}
	return b.String()
}

func summarizeTwinFromTelemetry(telemetry string) (map[string]any, error) {
	if telemetry == "" {
		return nil, fmt.Errorf("no telemetry")
	}
	var tel map[string]any
	if err := json.Unmarshal([]byte(telemetry), &tel); err != nil {
		return nil, err
	}
	summary := map[string]any{
		"zones":               tel["zones"],
		"twin_manifest_path":  tel["twin_manifest_path"],
		"twin_dir":            tel["twin_dir"],
		"omniverse_export_dir": tel["omniverse_export_dir"],
		"simready_ready":      tel["simready_ready"],
		"twin_manifest":       tel["twin_manifest"],
	}
	if twinDir, _ := tel["twin_dir"].(string); twinDir != "" {
		manifestPath := filepath.Join(twinDir, "twin_manifest.json")
		if raw, err := os.ReadFile(manifestPath); err == nil {
			var manifest map[string]any
			if json.Unmarshal(raw, &manifest) == nil {
				summary["zone_count"] = len(asSlice(manifest["zones"]))
				summary["prim_count"] = len(asSlice(manifest["prims"]))
				summary["up_axis"] = manifest["up_axis"]
				summary["meters_per_unit"] = manifest["meters_per_unit"]
			}
		}
	}
	return summary, nil
}

func asSlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}
