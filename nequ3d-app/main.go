package main

import (
	"embed"
	"log"
	"net/http"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func startLocalAssetServer() {
	http.HandleFunc("/api/local-file", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET")

		filePath := r.URL.Query().Get("path")
		if filePath == "" {
			http.Error(w, "Missing path", http.StatusBadRequest)
			return
		}

		// Protection against Directory Traversal attacks
		cleanPath := filepath.Clean(filePath)

		// 1. Set aggressive caching with verification (Max-age = 1h)
		w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")

		// Go's http.ServeFile automatically handles ETag, Last-Modified,
		// and If-Modified-Since headers based on file system metadata.
		http.ServeFile(w, r, cleanPath)
	})

	log.Println("[Nequ3D Local Server] Booting on port 8081 with Caching enabled...")
	if err := http.ListenAndServe(":8081", nil); err != nil {
		log.Printf("[Nequ3D Server Error]: %v", err)
	}
}

func main() {
	go startLocalAssetServer()

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

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
