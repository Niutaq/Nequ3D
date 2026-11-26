package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestCloudEventsJetStreamPersistenceAndReplay(t *testing.T) {
	storeDir := t.TempDir()
	StopEmbeddedNATS()
	if err := StartEmbeddedNATSWithDir(nil, storeDir, -1); err != nil {
		t.Fatalf("StartEmbeddedNATSWithDir failed: %v", err)
	}
	defer StopEmbeddedNATS()

	initOpenTelemetry()
	ctx, span := edgeTracer().Start(context.Background(), "nequ3d.test.cloudevent")
	traceID := span.SpanContext().TraceID().String()

	ce1, err := publishTwinCloudEvent(ctx, "io.nequ3d.twin.scan.processed", "Flat.usdz", map[string]any{
		"vertices": 18420,
		"bpp":      4,
	})
	span.End()
	if err != nil {
		t.Fatalf("publish ce1: %v", err)
	}
	if ce1.SpecVersion != "1.0" || ce1.StreamSeq != 1 {
		t.Fatalf("unexpected ce1 metadata: %+v", ce1)
	}
	if !strings.Contains(ce1.TraceParent, traceID) {
		t.Fatalf("expected traceparent containing %s, got %q", traceID, ce1.TraceParent)
	}

	_, err = publishTwinCloudEvent(context.Background(), "io.nequ3d.twin.annotations.saved", "Flat.usdz", map[string]any{
		"zones": 2,
		"pins":  3,
	})
	if err != nil {
		t.Fatalf("publish ce2: %v", err)
	}

	// Simulate app restart over the same JetStream StoreDir to prove durability!
	StopEmbeddedNATS()
	if err := StartEmbeddedNATSWithDir(nil, storeDir, -1); err != nil {
		t.Fatalf("restart embedded NATS failed: %v", err)
	}

	app := NewApp()
	raw, err := app.GetTwinEvents(10)
	if err != nil {
		t.Fatalf("GetTwinEvents failed: %v", err)
	}
	var events []CloudEvent
	if err := json.Unmarshal([]byte(raw), &events); err != nil {
		t.Fatalf("unmarshal replay: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 persisted CloudEvents after restart, got %d", len(events))
	}
	// Newest first
	if events[0].Type != "io.nequ3d.twin.annotations.saved" || events[0].StreamSeq != 2 {
		t.Fatalf("unexpected latest event: %+v", events[0])
	}
	if events[1].Type != "io.nequ3d.twin.scan.processed" || !strings.Contains(events[1].TraceParent, traceID) {
		t.Fatalf("unexpected earlier event: %+v", events[1])
	}
}
