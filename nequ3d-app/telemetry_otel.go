package main

import (
	"context"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc/metadata"
)

var (
	otelInitOnce sync.Once
	otelShutdown func(context.Context) error
)

// initOpenTelemetry configures the global W3C TraceContext propagator and an
// OTLP/HTTP trace exporter (defaulting to local Jaeger on 127.0.0.1:4318).
// Export failures are non-blocking so offline / lite sessions never stall.
func initOpenTelemetry() func(context.Context) error {
	otelInitOnce.Do(func() {
		otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{},
			propagation.Baggage{},
		))

		rawEndpoint := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
		if rawEndpoint == "" {
			rawEndpoint = "http://127.0.0.1:4318"
		}

		hostPort := strings.TrimPrefix(strings.TrimPrefix(rawEndpoint, "http://"), "https://")
		if u, err := url.Parse(rawEndpoint); err == nil && u.Host != "" {
			hostPort = u.Host
		}

		res, _ := resource.New(
			context.Background(),
			resource.WithAttributes(
				semconv.ServiceName("nequ3d-edge"),
				attribute.String("service.namespace", "nequ3d"),
				semconv.ServiceVersion("3.1.0"),
			),
		)

		exp, err := otlptracehttp.New(
			context.Background(),
			otlptracehttp.WithEndpoint(hostPort),
			otlptracehttp.WithInsecure(),
			otlptracehttp.WithTimeout(2*time.Second),
		)

		var tp *sdktrace.TracerProvider
		if err == nil {
			tp = sdktrace.NewTracerProvider(
				sdktrace.WithBatcher(exp, sdktrace.WithBatchTimeout(1500*time.Millisecond)),
				sdktrace.WithResource(res),
			)
		} else {
			tp = sdktrace.NewTracerProvider(sdktrace.WithResource(res))
		}
		otel.SetTracerProvider(tp)
		otelShutdown = tp.Shutdown
	})
	if otelShutdown == nil {
		return func(context.Context) error { return nil }
	}
	return otelShutdown
}

func edgeTracer() trace.Tracer {
	initOpenTelemetry()
	return otel.Tracer("nequ3d.edge")
}

// injectTraceMetadata attaches W3C traceparent/tracestate headers to outgoing gRPC calls.
func injectTraceMetadata(ctx context.Context) context.Context {
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	if len(carrier) == 0 {
		return ctx
	}
	pairs := make([]string, 0, len(carrier)*2)
	for k, v := range carrier {
		pairs = append(pairs, strings.ToLower(k), v)
	}
	return metadata.AppendToOutgoingContext(ctx, pairs...)
}

func jaegerTraceURL(traceID string) string {
	if traceID == "" {
		return ""
	}
	uiBase := strings.TrimSpace(os.Getenv("NEQU3D_JAEGER_UI"))
	if uiBase == "" {
		uiBase = "http://127.0.0.1:16686"
	}
	return strings.TrimRight(uiBase, "/") + "/trace/" + traceID
}
