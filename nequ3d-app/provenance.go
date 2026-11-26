package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	inTotoStatementType = "https://in-toto.io/Statement/v1"
	slsaPredicateType   = "https://slsa.dev/provenance/v1"
	dssePayloadType     = "application/vnd.in-toto+json"
	orasArtifactType    = "application/vnd.nequ3d.twin.v1+json"
)

type dsseEnvelope struct {
	PayloadType string          `json:"payloadType"`
	Payload     string          `json:"payload"`
	Signatures  []dsseSignature `json:"signatures"`
}

type dsseSignature struct {
	KeyID string `json:"keyid"`
	Sig   string `json:"sig"`
}

type inTotoSubject struct {
	Name   string            `json:"name"`
	Digest map[string]string `json:"digest"`
}

type inTotoStatement struct {
	Type          string          `json:"_type"`
	Subject       []inTotoSubject `json:"subject"`
	PredicateType string          `json:"predicateType"`
	Predicate     map[string]any  `json:"predicate"`
}

// ProvenanceVerification summarizes live cryptographic verification of a twin export bundle.
type ProvenanceVerification struct {
	Verified         bool              `json:"verified"`
	StatementType    string            `json:"statement_type"`
	PredicateType    string            `json:"predicate_type"`
	ArtifactType     string            `json:"artifact_type"`
	IntotoPath       string            `json:"intoto_path"`
	OrasManifestPath string            `json:"oras_manifest_path"`
	IntotoSHA256     string            `json:"intoto_sha256"`
	SignatureValid   bool              `json:"signature_valid"`
	SubjectCount     int               `json:"subject_count"`
	VerifiedSubjects []string          `json:"verified_subjects"`
	Mismatches       []string          `json:"mismatches,omitempty"`
	BuilderID        string            `json:"builder_id,omitempty"`
	InvocationID     string            `json:"invocation_id,omitempty"`
	CheckedAt        string            `json:"checked_at"`
	Details          map[string]string `json:"details,omitempty"`
}

func dssePAE(payloadType string, payload []byte) []byte {
	header := fmt.Sprintf("DSSEv1 %d %s %d ", len(payloadType), payloadType, len(payload))
	out := make([]byte, 0, len(header)+len(payload))
	out = append(out, []byte(header)...)
	out = append(out, payload...)
	return out
}

func attestationKey() []byte {
	if k := strings.TrimSpace(os.Getenv("NEQU3D_ATTESTATION_KEY")); k != "" {
		return []byte(k)
	}
	return []byte("nequ3d-local-dev-dsse-key")
}

func mediaTypeForArtifact(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".usda":
		return "model/vnd.usd+usda"
	case ".usd", ".usdc":
		return "model/vnd.usd"
	case ".usdz":
		return "model/vnd.usdz+zip"
	case ".glb":
		return "model/gltf-binary"
	case ".ntc":
		return "application/vnd.nvidia.rtxntc"
	case ".splat":
		return "application/vnd.nequ3d.gsplat"
	case ".json":
		return "application/json"
	default:
		if strings.HasSuffix(name, ".intoto.jsonl") {
			return dssePayloadType
		}
		return "application/octet-stream"
	}
}

// generateEdgeProvenance writes or refreshes `provenance.intoto.jsonl` + `oras_artifact_manifest.json`
// directly on the Go Edge (e.g. after SaveTwinAnnotations mutates twin_manifest.json / annotations.usda,
// or when running against a pre-provenance Core container).
func generateEdgeProvenance(targetDir string, traceID string) (string, string, error) {
	entries, err := os.ReadDir(targetDir)
	if err != nil {
		return "", "", err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if n == "provenance.intoto.jsonl" || n == "oras_artifact_manifest.json" || strings.HasSuffix(n, ".sha256.json") {
			continue
		}
		names = append(names, n)
	}
	sort.Strings(names)

	subjects := make([]inTotoSubject, 0, len(names))
	ociLayers := make([]map[string]any, 0, len(names)+1)

	for _, name := range names {
		full := filepath.Join(targetDir, name)
		info, err := os.Stat(full)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		sum, err := fileSHA256(full)
		if err != nil {
			continue
		}
		subjects = append(subjects, inTotoSubject{
			Name:   name,
			Digest: map[string]string{"sha256": sum},
		})
		ociLayers = append(ociLayers, map[string]any{
			"mediaType": mediaTypeForArtifact(name),
			"digest":    "sha256:" + sum,
			"size":      info.Size(),
			"annotations": map[string]string{
				"org.opencontainers.image.title": name,
			},
		})
	}

	nowISO := time.Now().UTC().Format(time.RFC3339)
	stmt := inTotoStatement{
		Type:          inTotoStatementType,
		Subject:       subjects,
		PredicateType: slsaPredicateType,
		Predicate: map[string]any{
			"buildDefinition": map[string]any{
				"buildType": "https://nequ3d.io/Attestations/OpenUSDNeuralTwin/v1",
				"externalParameters": map[string]any{
					"target_dir": filepath.Base(targetDir),
				},
			},
			"runDetails": map[string]any{
				"builder": map[string]any{
					"id": "https://nequ3d.io/builders/nequ3d-edge@v3.1.0",
				},
				"metadata": map[string]any{
					"invocationId": traceID,
					"finishedOn":   nowISO,
				},
			},
		},
	}

	payloadBytes, err := json.Marshal(stmt)
	if err != nil {
		return "", "", err
	}
	pae := dssePAE(dssePayloadType, payloadBytes)
	mac := hmac.New(sha256.New, attestationKey())
	mac.Write(pae)
	sigB64 := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	env := dsseEnvelope{
		PayloadType: dssePayloadType,
		Payload:     base64.StdEncoding.EncodeToString(payloadBytes),
		Signatures: []dsseSignature{
			{
				KeyID: "nequ3d-dsse-hmac-sha256-v1",
				Sig:   sigB64,
			},
		},
	}
	envRaw, err := json.Marshal(env)
	if err != nil {
		return "", "", err
	}

	intotoPath := filepath.Join(targetDir, "provenance.intoto.jsonl")
	if err := os.WriteFile(intotoPath, append(envRaw, '\n'), 0o644); err != nil {
		return "", "", err
	}

	if intotoSum, err := fileSHA256(intotoPath); err == nil {
		if st, err := os.Stat(intotoPath); err == nil {
			ociLayers = append(ociLayers, map[string]any{
				"mediaType": dssePayloadType,
				"digest":    "sha256:" + intotoSum,
				"size":      st.Size(),
				"annotations": map[string]string{
					"org.opencontainers.image.title": "provenance.intoto.jsonl",
					"io.in-toto.predicate-type":      slsaPredicateType,
				},
			})
		}
	}

	orasDoc := map[string]any{
		"schemaVersion": 2,
		"mediaType":     "application/vnd.oci.image.manifest.v1+json",
		"artifactType":  orasArtifactType,
		"config": map[string]any{
			"mediaType": "application/vnd.oci.empty.v1+json",
			"digest":    "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
			"size":      2,
		},
		"layers": ociLayers,
		"annotations": map[string]string{
			"org.opencontainers.image.created": nowISO,
			"org.opencontainers.image.source":  "https://github.com/Niutaq/Nequ3D",
			"io.nequ3d.trace_id":               traceID,
		},
	}
	orasRaw, _ := json.MarshalIndent(orasDoc, "", "  ")
	orasPath := filepath.Join(targetDir, "oras_artifact_manifest.json")
	_ = os.WriteFile(orasPath, orasRaw, 0o644)

	return intotoPath, orasPath, nil
}

func verifyProvenanceDir(targetDir string) (*ProvenanceVerification, error) {
	intotoPath := filepath.Join(targetDir, "provenance.intoto.jsonl")
	orasPath := filepath.Join(targetDir, "oras_artifact_manifest.json")

	rawLine, err := os.ReadFile(intotoPath)
	if err != nil {
		return nil, fmt.Errorf("provenance bundle not found at %s: %w", intotoPath, err)
	}
	firstLine := strings.TrimSpace(strings.Split(string(rawLine), "\n")[0])
	var env dsseEnvelope
	if err := json.Unmarshal([]byte(firstLine), &env); err != nil {
		return nil, fmt.Errorf("parse DSSE envelope: %w", err)
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(env.Payload)
	if err != nil {
		return nil, fmt.Errorf("decode DSSE payload: %w", err)
	}

	sigValid := false
	if len(env.Signatures) > 0 {
		pae := dssePAE(env.PayloadType, payloadBytes)
		mac := hmac.New(sha256.New, attestationKey())
		mac.Write(pae)
		expectedSig := mac.Sum(nil)
		if gotSig, err := base64.StdEncoding.DecodeString(env.Signatures[0].Sig); err == nil {
			sigValid = hmac.Equal(gotSig, expectedSig)
		}
	}

	var stmt inTotoStatement
	if err := json.Unmarshal(payloadBytes, &stmt); err != nil {
		return nil, fmt.Errorf("parse in-toto statement: %w", err)
	}

	verifiedSubjects := make([]string, 0, len(stmt.Subject))
	var mismatches []string

	for _, subj := range stmt.Subject {
		want := strings.ToLower(strings.TrimSpace(subj.Digest["sha256"]))
		if want == "" {
			mismatches = append(mismatches, subj.Name+": missing sha256 in statement")
			continue
		}
		got, err := fileSHA256(filepath.Join(targetDir, filepath.Base(subj.Name)))
		if err != nil {
			mismatches = append(mismatches, subj.Name+": missing on disk")
			continue
		}
		if !strings.EqualFold(got, want) {
			mismatches = append(mismatches, fmt.Sprintf("%s: digest mismatch (got %s… want %s…)", subj.Name, got[:8], want[:8]))
			continue
		}
		verifiedSubjects = append(verifiedSubjects, subj.Name)
	}

	intotoSum, _ := fileSHA256(intotoPath)
	var builderID, invocationID string
	if rd, ok := stmt.Predicate["runDetails"].(map[string]any); ok {
		if b, ok := rd["builder"].(map[string]any); ok {
			builderID, _ = b["id"].(string)
		}
		if m, ok := rd["metadata"].(map[string]any); ok {
			invocationID, _ = m["invocationId"].(string)
		}
	}

	okAll := stmt.Type == inTotoStatementType &&
		sigValid &&
		len(stmt.Subject) > 0 &&
		len(mismatches) == 0

	return &ProvenanceVerification{
		Verified:         okAll,
		StatementType:    stmt.Type,
		PredicateType:    stmt.PredicateType,
		ArtifactType:     orasArtifactType,
		IntotoPath:       intotoPath,
		OrasManifestPath: orasPath,
		IntotoSHA256:     intotoSum,
		SignatureValid:   sigValid,
		SubjectCount:     len(stmt.Subject),
		VerifiedSubjects: verifiedSubjects,
		Mismatches:       mismatches,
		BuilderID:        builderID,
		InvocationID:     invocationID,
		CheckedAt:        time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func enrichTelemetryWithProvenance(ctx context.Context, telemetryJSON string, traceID string) string {
	var m map[string]any
	if err := json.Unmarshal([]byte(telemetryJSON), &m); err != nil || m == nil {
		return telemetryJSON
	}
	targetDir, _ := m["omniverse_export_dir"].(string)
	if targetDir == "" {
		targetDir, _ = m["twin_dir"].(string)
	}
	if targetDir == "" {
		return telemetryJSON
	}
	info, err := os.Stat(targetDir)
	if err != nil || !info.IsDir() {
		return telemetryJSON
	}

	intotoPath := filepath.Join(targetDir, "provenance.intoto.jsonl")
	if _, err := os.Stat(intotoPath); err != nil {
		_, _, _ = generateEdgeProvenance(targetDir, traceID)
	}

	ver, err := verifyProvenanceDir(targetDir)
	if err != nil {
		return telemetryJSON
	}
	m["provenance_verification"] = ver
	if ver.Verified {
		_, _ = publishTwinCloudEvent(ctx, "io.nequ3d.twin.provenance.attested", filepath.Base(targetDir), map[string]any{
			"subject_count": ver.SubjectCount,
			"intoto_sha256": hexShort(ver.IntotoSHA256),
			"predicate":     ver.PredicateType,
		})
	}
	out, err := json.Marshal(m)
	if err != nil {
		return telemetryJSON
	}
	return string(out)
}

func hexShort(s string) string {
	if len(s) > 12 {
		return hex.EncodeToString([]byte{}) + s[:12]
	}
	return s
}

// VerifyTwinProvenance verifies (or refreshes when missing) the DSSE-signed in-toto v1
// provenance statement and ORAS manifest for an Omniverse/twin directory.
func (a *App) VerifyTwinProvenance(dirPath string) (string, error) {
	clean := strings.TrimSpace(dirPath)
	if clean == "" {
		return "", fmt.Errorf("directory path is empty")
	}
	if _, err := os.Stat(filepath.Join(clean, "provenance.intoto.jsonl")); err != nil {
		if _, _, genErr := generateEdgeProvenance(clean, ""); genErr != nil {
			return "", genErr
		}
	}
	ver, err := verifyProvenanceDir(clean)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(ver)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
