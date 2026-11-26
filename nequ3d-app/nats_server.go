package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"github.com/wailsapp/wails/v3/pkg/application"
	"go.opentelemetry.io/otel/trace"
)

const (
	twinStreamName    = "NEQU3D_TWIN_EVENTS"
	twinSubjectPrefix = "nequ3d.twin."
	twinSubjectWild   = "nequ3d.twin.>"
)

// CloudEvent implements the CNCF CloudEvents v1.0 specification (structured JSON mode)
// with the W3C Distributed Tracing extension attribute (`traceparent`).
type CloudEvent struct {
	SpecVersion     string `json:"specversion"`
	ID              string `json:"id"`
	Source          string `json:"source"`
	Type            string `json:"type"`
	Subject         string `json:"subject,omitempty"`
	Time            string `json:"time"`
	DataContentType string `json:"datacontenttype,omitempty"`
	TraceParent     string `json:"traceparent,omitempty"`
	StreamSeq       uint64 `json:"streamseq,omitempty"`
	Data            any    `json:"data,omitempty"`
}

var (
	natsMu       sync.Mutex
	embeddedNATS *server.Server
	natsConn     *nats.Conn
	jetStreamCtx nats.JetStreamContext
	natsWailsApp *application.App
)

func defaultNATSStoreDir() string {
	if custom := strings.TrimSpace(os.Getenv("NEQU3D_NATS_STORE_DIR")); custom != "" {
		return custom
	}
	cwd, _ := os.Getwd()
	dir, err := filepath.Abs(filepath.Join(cwd, "..", "data", "nats-jetstream"))
	if err != nil {
		return filepath.Join(os.TempDir(), "nequ3d-nats-jetstream")
	}
	return dir
}

// StartEmbeddedNATS initializes an in-process CNCF NATS JetStream server and durable stream.
func StartEmbeddedNATS(app *application.App) error {
	return StartEmbeddedNATSWithDir(app, defaultNATSStoreDir(), resolveNATSPort())
}

func resolveNATSPort() int {
	if raw := strings.TrimSpace(os.Getenv("NEQU3D_NATS_PORT")); raw != "" {
		if p, err := strconv.Atoi(raw); err == nil {
			return p
		}
	}
	// -1 selects an ephemeral free loopback port so parallel sessions/tests never collide;
	// set NEQU3D_NATS_PORT=4222 to pin port 4222 for external NATS CLI inspection.
	return -1
}

func StartEmbeddedNATSWithDir(app *application.App, storeDir string, port int) error {
	natsMu.Lock()
	defer natsMu.Unlock()

	natsWailsApp = app
	if embeddedNATS != nil && natsConn != nil && jetStreamCtx != nil {
		return nil
	}

	if err := os.MkdirAll(storeDir, 0o755); err != nil {
		return fmt.Errorf("create NATS store dir: %w", err)
	}

	opts := &server.Options{
		ServerName: "nequ3d-edge-jetstream",
		Host:       "127.0.0.1",
		Port:       port,
		JetStream:  true,
		StoreDir:   storeDir,
		NoSigs:     true,
		NoLog:      true,
	}

	ns, err := server.NewServer(opts)
	if err != nil {
		slog.Error("[NATS] Failed to initialize embedded NATS", "err", err)
		return err
	}

	go ns.Start()
	if !ns.ReadyForConnections(8 * time.Second) {
		ns.Shutdown()
		return fmt.Errorf("embedded NATS JetStream server did not become ready")
	}

	nc, err := nats.Connect(ns.ClientURL(), nats.Name("nequ3d-edge"))
	if err != nil {
		ns.Shutdown()
		return fmt.Errorf("connect embedded NATS: %w", err)
	}

	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		ns.Shutdown()
		return fmt.Errorf("init JetStream context: %w", err)
	}

	streamCfg := &nats.StreamConfig{
		Name:        twinStreamName,
		Description: "Nequ3D Building Renovation Digital Twin CloudEvents v1.0 timeline",
		Subjects:    []string{twinSubjectWild},
		Storage:     nats.FileStorage,
		Retention:   nats.LimitsPolicy,
		MaxMsgs:     500,
		MaxBytes:    16 * 1024 * 1024,
		MaxAge:      30 * 24 * time.Hour,
		Discard:     nats.DiscardOld,
	}
	if _, err := js.StreamInfo(twinStreamName); err != nil {
		if _, err := js.AddStream(streamCfg); err != nil {
			nc.Close()
			ns.Shutdown()
			return fmt.Errorf("create JetStream stream: %w", err)
		}
	} else {
		_, _ = js.UpdateStream(streamCfg)
	}

	embeddedNATS = ns
	natsConn = nc
	jetStreamCtx = js
	slog.Info("[NATS] Embedded JetStream CloudEvents broker ready", "url", ns.ClientURL(), "stream", twinStreamName)
	return nil
}

// StopEmbeddedNATS flushes and shuts down the embedded NATS JetStream server cleanly.
func StopEmbeddedNATS() {
	natsMu.Lock()
	defer natsMu.Unlock()

	if natsConn != nil {
		_ = natsConn.Drain()
		natsConn.Close()
		natsConn = nil
	}
	jetStreamCtx = nil
	if embeddedNATS != nil {
		embeddedNATS.Shutdown()
		embeddedNATS.WaitForShutdown()
		embeddedNATS = nil
	}
}

func newCloudEventID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("ce-%d", time.Now().UnixNano())
	}
	return "ce-" + hex.EncodeToString(b[:])
}

func traceParentFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	sc := trace.SpanFromContext(ctx).SpanContext()
	if !sc.IsValid() {
		return ""
	}
	flags := "00"
	if sc.IsSampled() {
		flags = "01"
	}
	return fmt.Sprintf("00-%s-%s-%s", sc.TraceID().String(), sc.SpanID().String(), flags)
}

func sanitizeNATSToken(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	var out strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			out.WriteRune(r)
		} else if r == '.' {
			out.WriteRune('.')
		}
	}
	res := strings.Trim(out.String(), ".")
	if res == "" {
		return "event"
	}
	return res
}

// publishTwinCloudEvent persists a CloudEvents v1.0 envelope to NATS JetStream
// and pushes it live to the Wails UI if active.
func publishTwinCloudEvent(ctx context.Context, eventType string, subject string, data any) (*CloudEvent, error) {
	natsMu.Lock()
	js := jetStreamCtx
	wApp := natsWailsApp
	natsMu.Unlock()

	ce := &CloudEvent{
		SpecVersion:     "1.0",
		ID:              newCloudEventID(),
		Source:          "urn:nequ3d:edge:desktop",
		Type:            eventType,
		Subject:         subject,
		Time:            time.Now().UTC().Format(time.RFC3339Nano),
		DataContentType: "application/json",
		TraceParent:     traceParentFromContext(ctx),
		Data:            data,
	}

	if js == nil {
		return ce, nil
	}

	shortSuffix := strings.TrimPrefix(eventType, "io.nequ3d.twin.")
	natsSubject := twinSubjectPrefix + sanitizeNATSToken(shortSuffix)

	raw, err := json.Marshal(ce)
	if err != nil {
		return nil, err
	}

	msg := nats.NewMsg(natsSubject)
	msg.Data = raw
	msg.Header.Set("Content-Type", "application/cloudevents+json; charset=UTF-8")
	msg.Header.Set("ce-specversion", ce.SpecVersion)
	msg.Header.Set("ce-id", ce.ID)
	msg.Header.Set("ce-source", ce.Source)
	msg.Header.Set("ce-type", ce.Type)
	if ce.TraceParent != "" {
		msg.Header.Set("traceparent", ce.TraceParent)
	}

	ack, err := js.PublishMsg(msg)
	if err != nil {
		slog.Warn("[NATS] Failed to publish CloudEvent", "type", eventType, "err", err)
		return ce, err
	}
	ce.StreamSeq = ack.Sequence

	// Re-marshal with assigned JetStream sequence for live UI broadcast
	if enriched, err := json.Marshal(ce); err == nil && wApp != nil {
		wApp.Event.Emit("twinCloudEvent", string(enriched))
	}
	return ce, nil
}

// replayTwinCloudEvents reads the latest `limit` persisted CloudEvents from NATS JetStream.
func replayTwinCloudEvents(limit int) ([]CloudEvent, error) {
	if limit <= 0 || limit > 200 {
		limit = 40
	}
	natsMu.Lock()
	js := jetStreamCtx
	natsMu.Unlock()
	if js == nil {
		return []CloudEvent{}, nil
	}

	info, err := js.StreamInfo(twinStreamName)
	if err != nil {
		return []CloudEvent{}, err
	}
	if info.State.Msgs == 0 {
		return []CloudEvent{}, nil
	}

	var startSeq uint64 = 1
	if info.State.Msgs > uint64(limit) && info.State.LastSeq >= uint64(limit) {
		startSeq = info.State.LastSeq - uint64(limit) + 1
	}
	if startSeq < info.State.FirstSeq {
		startSeq = info.State.FirstSeq
	}

	sub, err := js.SubscribeSync(
		twinSubjectWild,
		nats.BindStream(twinStreamName),
		nats.StartSequence(startSeq),
		nats.OrderedConsumer(),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = sub.Unsubscribe() }()

	expected := int(info.State.LastSeq - startSeq + 1)
	if expected > limit {
		expected = limit
	}
	events := make([]CloudEvent, 0, expected)
	deadline := time.Now().Add(600 * time.Millisecond)

	for len(events) < expected && time.Now().Before(deadline) {
		m, err := sub.NextMsg(80 * time.Millisecond)
		if err != nil {
			break
		}
		var ce CloudEvent
		if json.Unmarshal(m.Data, &ce) == nil && ce.ID != "" {
			if meta, err := m.Metadata(); err == nil {
				ce.StreamSeq = meta.Sequence.Stream
			}
			events = append(events, ce)
		}
		if meta, err := m.Metadata(); err == nil && meta.Sequence.Stream >= info.State.LastSeq {
			break
		}
	}

	// Newest first for UI timeline display
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	if len(events) > limit {
		events = events[:limit]
	}
	return events, nil
}

// GetTwinEvents returns persisted CloudEvents v1.0 from embedded NATS JetStream (newest first).
func (a *App) GetTwinEvents(limit int) (string, error) {
	events, err := replayTwinCloudEvents(limit)
	if err != nil {
		return "[]", err
	}
	raw, err := json.Marshal(events)
	if err != nil {
		return "[]", err
	}
	return string(raw), nil
}
