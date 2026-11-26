package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProvenanceGenerationAndTamperDetection(t *testing.T) {
	dir := t.TempDir()
	manifestFile := filepath.Join(dir, "twin_manifest.json")
	usdaFile := filepath.Join(dir, "building_twin.usda")

	if err := os.WriteFile(manifestFile, []byte(`{"schema_version":1,"zones":[{"id":"kitchen"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(usdaFile, []byte("#usda 1.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	intotoPath, orasPath, err := generateEdgeProvenance(dir, "4f1a0d638c243d7e3ebbcb510209dfc8")
	if err != nil {
		t.Fatalf("generateEdgeProvenance failed: %v", err)
	}
	if _, err := os.Stat(intotoPath); err != nil {
		t.Fatalf("missing intoto bundle: %v", err)
	}
	if _, err := os.Stat(orasPath); err != nil {
		t.Fatalf("missing oras manifest: %v", err)
	}

	ver, err := verifyProvenanceDir(dir)
	if err != nil {
		t.Fatalf("verifyProvenanceDir failed: %v", err)
	}
	if !ver.Verified || !ver.SignatureValid || ver.SubjectCount != 2 {
		t.Fatalf("expected verified=true with 2 subjects, got %+v", ver)
	}

	// Tamper with building_twin.usda and verify tamper detection triggers!
	if err := os.WriteFile(usdaFile, []byte("#usda 1.0\n# tampered\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	verTampered, err := verifyProvenanceDir(dir)
	if err != nil {
		t.Fatalf("verifyProvenanceDir after tamper failed: %v", err)
	}
	if verTampered.Verified || len(verTampered.Mismatches) == 0 {
		t.Fatalf("expected tamper detection failure, got %+v", verTampered)
	}
}
