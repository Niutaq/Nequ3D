package main

import (
	"context"
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

//go:embed build/appicon.png
var appIcon []byte

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
	shutdownOTel := initOpenTelemetry()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = shutdownOTel(ctx)
	}()

	urlCh := make(chan string, 1)
	go startLocalAssetServer(urlCh)

	app := application.New(application.Options{
		Name:        "nequ3d-app",
		Description: "Nequ3D Building Renovation Digital Twin",
		Icon:        appIcon,
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

	// Publish the local-file server URL on startup and whenever the frontend requests it,
	// avoiding an infinite 1s IPC broadcast loop.
	go func() {
		if url, ok := <-urlCh; ok {
			app.Event.On("requestLocalServerUrl", func(_ *application.CustomEvent) {
				app.Event.Emit("localServerUrl", url)
			})
			for _, delay := range []time.Duration{250 * time.Millisecond, 900 * time.Millisecond, 2200 * time.Millisecond} {
				time.Sleep(delay)
				app.Event.Emit("localServerUrl", url)
			}
		}
	}()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
