package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"google.golang.org/grpc/metadata"
)

func TestOpenTelemetryPropagationAndEnrichment(t *testing.T) {
	shutdown := initOpenTelemetry()
	if shutdown == nil {
		t.Fatal("expected non-nil OpenTelemetry shutdown func")
	}

	ctx, span := edgeTracer().Start(context.Background(), "nequ3d.test.root")
	defer span.End()

	traceID := span.SpanContext().TraceID().String()
	if len(traceID) != 32 || traceID == "00000000000000000000000000000000" {
		t.Fatalf("expected valid 32-hex trace_id, got %q", traceID)
	}

	outCtx := injectTraceMetadata(ctx)
	md, ok := metadata.FromOutgoingContext(outCtx)
	if !ok {
		t.Fatal("expected outgoing gRPC metadata with W3C traceparent")
	}
	tp := md.Get("traceparent")
	if len(tp) == 0 || !strings.Contains(tp[0], traceID) {
		t.Fatalf("expected traceparent containing %s, got %v", traceID, tp)
	}

	enriched := enrichTelemetryWithTrace(
		`{"vertices":1024,"stage_timings_ms":{"ntc_ms":42.5}}`,
		traceID,
		map[string]float64{"sha256_ms": 3.24, "minio_upload_ms": 12.88, "total_ms": 68.12},
	)

	var parsed map[string]any
	if err := json.Unmarshal([]byte(enriched), &parsed); err != nil {
		t.Fatalf("unmarshal enriched telemetry: %v", err)
	}
	if parsed["trace_id"] != traceID {
		t.Fatalf("expected trace_id=%s, got %v", traceID, parsed["trace_id"])
	}
	jaegerURL, _ := parsed["jaeger_url"].(string)
	if !strings.HasSuffix(jaegerURL, "/trace/"+traceID) {
		t.Fatalf("expected jaeger_url ending with /trace/%s, got %q", traceID, jaegerURL)
	}
	edgeMap, ok := parsed["edge_timings_ms"].(map[string]any)
	if !ok || edgeMap["minio_upload_ms"] != 12.9 {
		t.Fatalf("expected rounded edge_timings_ms, got %v", parsed["edge_timings_ms"])
	}
}
