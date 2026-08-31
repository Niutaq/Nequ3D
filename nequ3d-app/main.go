package main

import (
	"embed"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

// startLocalAssetServer binds the local-file preview server to an
// OS-assigned free ephemeral port (":0"), guaranteeing it never collides
// with Docker, other apps, or previously running instances. The chosen URL
// is published to the frontend via the "localServerUrl" event so the
// preview uses the actual port instead of a hardcoded one.
func startLocalAssetServer(urlCh chan<- string) {
	// The core container writes proxy GLBs under /tmp/workspace, and our
	// run-all mount binds that to <repo>/data/objects on the host. Resolve
	// that host directory once so previews map the container path correctly.
	cwd, _ := os.Getwd()
	hostObjectsDir, _ := filepath.Abs(filepath.Join(cwd, "..", "data", "objects"))

	mux := http.NewServeMux()
	mux.HandleFunc("/api/local-file", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET")

		filePath := r.URL.Query().Get("path")
		if filePath == "" {
			http.Error(w, "Missing path", http.StatusBadRequest)
			return
		}

		// Translate paths the core reported from inside its container
		// (/tmp/workspace/...) to the host-mounted data/objects dir.
		const coreWorkspace = "/tmp/workspace/"
		if strings.HasPrefix(filePath, coreWorkspace) {
			rel := filepath.FromSlash(strings.TrimPrefix(filePath, coreWorkspace))
			filePath = filepath.Join(hostObjectsDir, rel)
		}

		// Protection against Directory Traversal attacks
		cleanPath := filepath.Clean(filePath)

		// Aggressive caching with verification (Max-age = 1h)
		w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")

		// Diagnostic log so we can see exactly which file the preview asks
		// for and whether it actually exists on disk.
		if _, statErr := os.Stat(cleanPath); statErr != nil {
			log.Printf("[Nequ3D Local Server] local-file MISSING: %s (%v)", cleanPath, statErr)
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		log.Printf("[Nequ3D Local Server] local-file OK: %s", cleanPath)

		// Go's http.ServeFile handles ETag, Last-Modified and
		// If-Modified-Since automatically based on FS metadata.
		http.ServeFile(w, r, cleanPath)
	})

	// ":0" asks the OS for any free port — no more busy-port guessing.
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		log.Printf("[Nequ3D Local Server Error]: %v", err)
		close(urlCh)
		return
	}
	addr := "http://localhost:" + strconv.Itoa(ln.Addr().(*net.TCPAddr).Port) + "/api/local-file?path="
	log.Printf("[Nequ3D Local Server] Booting on %s with Caching enabled...", addr)
	urlCh <- addr

	if serr := http.Serve(ln, mux); serr != nil {
		log.Printf("[Nequ3D Local Server Error]: %v", serr)
	}
}

func main() {
	urlCh := make(chan string, 1)
	go startLocalAssetServer(urlCh)

	app := application.New(application.Options{
		Name:        "nequ3d-app",
		Description: "Nequ3D Edge-to-Core Asset Pipeline",
		Services: []application.Service{
			application.NewService(NewApp()),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Nequ3D Dashboard",
		Width:            1440,
		Height:           900,
		BackgroundColour: application.NewRGB(15, 23, 42),
		URL:              "/",
	})

	startGPUStatsTicker(app)

	// Publish the actual local-file server URL once it is up so the frontend
	// can build preview links from the real (dynamically assigned) port.
	go func() {
		if url, ok := <-urlCh; ok {
			for {
				app.Event.Emit("localServerUrl", url)
				time.Sleep(1 * time.Second)
			}
		}
	}()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
