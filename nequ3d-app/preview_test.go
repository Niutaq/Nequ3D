package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestPreviewAccess(t *testing.T) {
	root := t.TempDir()
	allowed := filepath.Join(root, "allowed.glb")
	private := filepath.Join(root, "private.txt")
	for _, path := range []string{allowed, private} {
		if err := os.WriteFile(path, []byte("asset"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	p := newPreviewFiles(root)
	p.register(allowed)
	for _, tc := range []struct {
		name, path, token, method string
		status                    int
	}{
		{"selected asset", allowed, p.token, "GET", 200},
		{"mapped workspace asset", "/tmp/workspace/allowed.glb", p.token, "GET", 200},
		{"unregistered sibling", private, p.token, "GET", 404},
		{"missing capability", allowed, "", "GET", 403},
		{"wrong capability", allowed, "wrong", "GET", 403},
		{"traversal", "/tmp/workspace/../private.txt", p.token, "GET", 404},
		{"directory", root, p.token, "GET", 404},
		{"write method", allowed, p.token, "POST", 405},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "/api/local-file?"+url.Values{"path": {tc.path}, "token": {tc.token}}.Encode(), nil)
			w := httptest.NewRecorder()
			p.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d", w.Code, tc.status)
			}
			if w.Code == http.StatusOK && w.Body.String() != "asset" {
				t.Fatal("incorrect asset content")
			}
		})
	}
}

func TestTelemetryRegistersNestedJobArtifacts(t *testing.T) {
	root := t.TempDir()
	job := filepath.Join(root, "job-123")
	if err := os.Mkdir(job, 0700); err != nil {
		t.Fatal(err)
	}
	asset := filepath.Join(job, "texture.png")
	if err := os.WriteFile(asset, []byte("texture"), 0600); err != nil {
		t.Fatal(err)
	}
	p := newPreviewFiles(root)
	p.registerTelemetry(`{"ntc_compressed_files":[{"reconstructed_path":"/tmp/workspace/job-123/texture.png"}]}`)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/api/local-file?"+url.Values{"path": {asset}, "token": {p.token}}.Encode(), nil))
	if w.Code != 200 {
		t.Fatalf("nested artifact not available: %d", w.Code)
	}
}
