package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Only paths explicitly selected by the user or returned by Core can be read.
type previewFiles struct {
	mu        sync.RWMutex
	paths     map[string]bool
	workspace string
	token     string
}

func newPreviewFiles(workspace string) *previewFiles {
	return &previewFiles{paths: make(map[string]bool), workspace: workspace, token: rand.Text()}
}

var previews = newPreviewFiles(defaultWorkspace())

func defaultWorkspace() string {
	if path := os.Getenv("NEQU3D_WORKSPACE"); path != "" {
		return path
	}
	cwd, _ := os.Getwd()
	path, _ := filepath.Abs(filepath.Join(cwd, "..", "data", "objects"))
	return path
}

func (p *previewFiles) resolve(path string) (string, error) {
	if strings.HasPrefix(path, "/tmp/workspace/") {
		rel := strings.TrimPrefix(path, "/tmp/workspace/")
		if !filepath.IsLocal(filepath.FromSlash(rel)) {
			return "", os.ErrPermission
		}
		path = filepath.Join(p.workspace, filepath.FromSlash(rel))
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

func (p *previewFiles) register(path string) {
	canonical, err := p.resolve(path)
	if err != nil {
		return
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	p.mu.Lock()
	p.paths[canonical] = true
	p.mu.Unlock()
}

func (p *previewFiles) registerTelemetry(raw string) {
	var value any
	if json.Unmarshal([]byte(raw), &value) != nil {
		return
	}
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			for key, child := range x {
				if strings.HasSuffix(key, "_path") {
					if path, ok := child.(string); ok && path != "" {
						p.register(path)
					}
				}
				walk(child)
			}
		case []any:
			for _, child := range x {
				walk(child)
			}
		}
	}
	walk(value)
}

func (p *previewFiles) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(p.token)) != 1 {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "Missing path", http.StatusBadRequest)
		return
	}
	canonical, err := p.resolve(path)
	p.mu.RLock()
	allowed := p.paths[canonical]
	p.mu.RUnlock()
	if err != nil || !allowed {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	// Wails uses different origins in development and packaged builds. The
	// per-session capability is required even when the request has no Origin.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.ServeFile(w, r, canonical)
}
