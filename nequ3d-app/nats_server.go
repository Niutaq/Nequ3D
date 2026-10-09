package main

import (
	"log/slog"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

var (
	embeddedNATS *server.Server
	NatsClient   *nats.Conn
)

// StartEmbeddedNATS initializes and starts a JetStream-enabled NATS server locally.
func StartEmbeddedNATS() {
	opts := &server.Options{
		Host:      "127.0.0.1",
		Port:      4222,
		JetStream: true,
		StoreDir:  "./nats-data", // persists jetstream messages locally
	}

	ns, err := server.NewServer(opts)
	if err != nil {
		slog.Error("[NATS] Failed to initialize embedded NATS", "err", err)
		return
	}

	go ns.Start()

	if !ns.ReadyForConnections(10 * time.Second) {
		slog.Error("[NATS] Embedded NATS server not ready in time")
		return
	}
	embeddedNATS = ns
	slog.Info("[NATS] Embedded JetStream Server started on :4222")

	// Connect our Go client to it
	nc, err := nats.Connect("nats://127.0.0.1:4222")
	if err != nil {
		slog.Error("[NATS] Failed to connect local NATS client", "err", err)
	} else {
		NatsClient = nc
		slog.Info("[NATS] Go client connected successfully!")
		
		// Setup a basic subscriber to listen to all 'pipeline.>' events for testing
		nc.Subscribe("pipeline.>", func(m *nats.Msg) {
			slog.Info("[NATS-STREAM]", "subject", m.Subject, "data", string(m.Data))
		})
	}
}

// StopEmbeddedNATS cleanly shuts down the NATS server on exit
func StopEmbeddedNATS() {
	if NatsClient != nil {
		NatsClient.Close()
	}
	if embeddedNATS != nil {
		slog.Info("[NATS] Shutting down embedded server...")
		embeddedNATS.Shutdown()
		embeddedNATS.WaitForShutdown()
		slog.Info("[NATS] Shutdown complete.")
	}
}
