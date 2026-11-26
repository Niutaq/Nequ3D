package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// TwinAnnotationPayload is persisted into twin_manifest.json next to Core outputs.
type TwinAnnotationPayload struct {
	TwinDir      string          `json:"twin_dir"`
	Measurements json.RawMessage `json:"measurements"`
	Annotations  json.RawMessage `json:"annotations"`
	Zones        json.RawMessage `json:"zones"`
	Detections   json.RawMessage `json:"detections"`
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func writeIntegritySidecar(path string, meta map[string]any) (string, error) {
	digest, err := fileSHA256(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	payload := map[string]any{
		"algorithm":  "sha256",
		"path":       filepath.Base(path),
		"sha256":     digest,
		"bytes":      info.Size(),
		"created_at": time.Now().UTC().Format(time.RFC3339),
	}
	if meta != nil {
		payload["meta"] = meta
	}
	out := path + ".sha256.json"
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(out, raw, 0o644); err != nil {
		return "", err
	}
	return digest, nil
}

// SaveTwinAnnotations merges UI measurements/zones into twin_manifest.json and refreshes annotations.usda text markers.
func (a *App) SaveTwinAnnotations(payloadJSON string) (string, error) {
	var payload TwinAnnotationPayload
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return "", fmt.Errorf("invalid twin annotation payload: %w", err)
	}
	if payload.TwinDir == "" {
		return "", fmt.Errorf("twin_dir is required")
	}
	manifestPath := filepath.Join(payload.TwinDir, "twin_manifest.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", fmt.Errorf("read twin_manifest: %w", err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return "", fmt.Errorf("parse twin_manifest: %w", err)
	}

	if len(payload.Measurements) > 0 && string(payload.Measurements) != "null" {
		var measurements any
		if err := json.Unmarshal(payload.Measurements, &measurements); err == nil {
			manifest["measurements"] = measurements
		}
	}
	if len(payload.Annotations) > 0 && string(payload.Annotations) != "null" {
		var annotations any
		if err := json.Unmarshal(payload.Annotations, &annotations); err == nil {
			manifest["annotations"] = annotations
		}
	}
	if len(payload.Detections) > 0 && string(payload.Detections) != "null" {
		var detections any
		if err := json.Unmarshal(payload.Detections, &detections); err == nil {
			manifest["detections"] = detections
		}
	}
	if len(payload.Zones) > 0 && string(payload.Zones) != "null" {
		var zoneUpdates []map[string]any
		if err := json.Unmarshal(payload.Zones, &zoneUpdates); err == nil {
			existing, _ := manifest["zones"].([]any)
			byID := map[string]map[string]any{}
			for _, z := range existing {
				if zm, ok := z.(map[string]any); ok {
					if id, _ := zm["id"].(string); id != "" {
						byID[id] = zm
					}
				}
			}
			for _, upd := range zoneUpdates {
				id, _ := upd["id"].(string)
				if id == "" {
					continue
				}
				if cur, ok := byID[id]; ok {
					for k, v := range upd {
						cur[k] = v
					}
				} else {
					byID[id] = upd
				}
			}
			merged := make([]any, 0, len(byID))
			for _, z := range byID {
				merged = append(merged, z)
			}
			manifest["zones"] = merged
		}
	}

	manifest["updated_at"] = time.Now().UTC().Format(time.RFC3339)
	out, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(manifestPath, out, 0o644); err != nil {
		return "", err
	}

	// Minimal annotations.usda rewrite (zone labels + measurement distances) without pxr on Windows edge.
	if err := writeAnnotationsUSDA(filepath.Join(payload.TwinDir, "annotations.usda"), manifest); err != nil {
		return "", err
	}

	digest, _ := writeIntegritySidecar(manifestPath, map[string]any{"kind": "twin_manifest"})
	intotoPath, _, _ := generateEdgeProvenance(payload.TwinDir, "")
	assetSubject := filepath.Base(payload.TwinDir)
	if src, ok := manifest["source_asset"].(string); ok && src != "" {
		assetSubject = filepath.Base(src)
	}
	_, _ = publishTwinCloudEvent(context.Background(), "io.nequ3d.twin.annotations.saved", assetSubject, map[string]any{
		"zone_count":        len(asSlice(manifest["zones"])),
		"measurement_count": len(asSlice(manifest["measurements"])),
		"pin_count":         len(asSlice(manifest["annotations"])),
		"manifest_sha256":   digest,
	})
	result, _ := json.Marshal(map[string]any{
		"status":             "saved",
		"twin_manifest_path": manifestPath,
		"sha256":             digest,
		"intoto_path":        intotoPath,
	})
	return string(result), nil
}

func writeAnnotationsUSDA(path string, manifest map[string]any) error {
	up, _ := manifest["up_axis"].(string)
	if up == "" {
		up = "Y"
	}
	mpu := 1.0
	switch v := manifest["meters_per_unit"].(type) {
	case float64:
		mpu = v
	}

	var b []byte
	b = append(b, []byte("#usda 1.0\n(\n")...)
	b = append(b, []byte(fmt.Sprintf("    doc = \"Nequ3D Building Renovation annotations\"\n    upAxis = \"%s\"\n    metersPerUnit = %g\n)\n\n", up, mpu))...)
	b = append(b, []byte("def Xform \"Nequ3DTwin\"\n{\n    def Xform \"Zones\"\n    {\n")...)

	if zones, ok := manifest["zones"].([]any); ok {
		for _, z := range zones {
			zm, _ := z.(map[string]any)
			id, _ := zm["id"].(string)
			if id == "" {
				continue
			}
			label, _ := zm["label"].(string)
			status, _ := zm["status"].(string)
			b = append(b, []byte(fmt.Sprintf("        def Xform \"%s\"\n        {\n", id))...)
			b = append(b, []byte(fmt.Sprintf("            custom string nequ3d:zoneLabel = \"%s\"\n", escapeUSDA(label)))...)
			b = append(b, []byte(fmt.Sprintf("            custom string nequ3d:status = \"%s\"\n", escapeUSDA(status)))...)
			b = append(b, []byte("        }\n\n")...)
		}
	}
	b = append(b, []byte("    }\n\n    def Xform \"Measurements\"\n    {\n")...)
	if measurements, ok := manifest["measurements"].([]any); ok {
		for i, m := range measurements {
			mm, _ := m.(map[string]any)
			id := mm["id"]
			if id == nil {
				id = i + 1
			}
			dist, _ := mm["distance"].(float64)
			b = append(b, []byte(fmt.Sprintf("        def Xform \"m_%v\"\n        {\n            custom double nequ3d:distance = %g\n        }\n\n", id, dist))...)
		}
	}
	b = append(b, []byte("    }\n\n    def Xform \"Labels\"\n    {\n")...)
	if annotations, ok := manifest["annotations"].([]any); ok {
		for i, a := range annotations {
			am, _ := a.(map[string]any)
			id := am["id"]
			if id == nil {
				id = i + 1
			}
			text, _ := am["text"].(string)
			kind, _ := am["kind"].(string)
			if kind == "" {
				kind = "note"
			}
			b = append(b, []byte(fmt.Sprintf("        def Xform \"pin_%v\"\n        {\n", id))...)
			b = append(b, []byte(fmt.Sprintf("            custom string nequ3d:text = \"%s\"\n", escapeUSDA(text)))...)
			b = append(b, []byte(fmt.Sprintf("            custom string nequ3d:kind = \"%s\"\n", escapeUSDA(kind)))...)
			if pos, ok := am["position"].(map[string]any); ok {
				px, _ := pos["x"].(float64)
				py, _ := pos["y"].(float64)
				pz, _ := pos["z"].(float64)
				b = append(b, []byte(fmt.Sprintf("            custom float3 nequ3d:position = (%g, %g, %g)\n", px, py, pz))...)
			}
			b = append(b, []byte("        }\n\n")...)
		}
	}
	b = append(b, []byte("    }\n}\n")...)
	return os.WriteFile(path, b, 0o644)
}

func escapeUSDA(s string) string {
	r := make([]rune, 0, len(s))
	for _, ch := range s {
		switch ch {
		case '\\', '"':
			r = append(r, '\\', ch)
		default:
			r = append(r, ch)
		}
	}
	return string(r)
}
