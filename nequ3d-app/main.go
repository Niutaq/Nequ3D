package main

import (
	"embed"
	"log"
	"net"
	"net/http"

	"strconv"

	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

// startLocalAssetServer exposes only registered preview assets on loopback.
func startLocalAssetServer(urlCh chan<- string) {
	mux := http.NewServeMux()
	mux.Handle("/api/local-file", previews)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Printf("[Nequ3D Local Server Error]: %v", err)
		close(urlCh)
		return
	}
	addr := "http://127.0.0.1:" + strconv.Itoa(ln.Addr().(*net.TCPAddr).Port) + "/api/local-file?token=" + previews.token + "&path="
	urlCh <- addr
	if err := http.Serve(ln, mux); err != nil {
		log.Printf("[Nequ3D Local Server Error]: %v", err)
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
