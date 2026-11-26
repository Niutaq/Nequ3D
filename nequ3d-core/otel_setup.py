"""Graceful OpenTelemetry setup & W3C TraceContext propagation for Nequ3D Core."""

from __future__ import annotations

import atexit
import contextlib
import os
from typing import Any, Iterator, Mapping

_PROVIDER = None
_TRACER = None
_PROPAGATOR = None
_OTEL_AVAILABLE = False

try:
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

    _OTEL_AVAILABLE = True
except Exception:  # pragma: no cover - optional when running bare offline tests
    trace = None  # type: ignore


def flush_otel(timeout_millis: int = 2500) -> None:
    """Flushes pending spans before short-lived subprocesses or RPC streams finish."""
    if _PROVIDER is not None:
        try:
            _PROVIDER.force_flush(timeout_millis=timeout_millis)
        except Exception:
            pass


def _shutdown_otel() -> None:
    if _PROVIDER is not None:
        try:
            _PROVIDER.shutdown()
        except Exception:
            pass


def init_core_tracer(service_name: str = "nequ3d-core") -> Any:
    """Initializes OTLP/HTTP tracer once; falls back to no-op if unavailable."""
    global _PROVIDER, _TRACER, _PROPAGATOR
    if _TRACER is not None:
        return _TRACER
    if not _OTEL_AVAILABLE:
        return None

    resolved_service = os.environ.get("OTEL_SERVICE_NAME", "").strip() or service_name
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    resource = Resource.create(
        {
            "service.name": resolved_service,
            "service.namespace": "nequ3d",
            "service.version": "4.0.0",
        }
    )
    provider = TracerProvider(resource=resource)
    if endpoint:
        traces_url = (
            endpoint
            if endpoint.endswith("/v1/traces")
            else endpoint.rstrip("/") + "/v1/traces"
        )
        exporter = OTLPSpanExporter(endpoint=traces_url, timeout=3)
        provider.add_span_processor(
            BatchSpanProcessor(exporter, schedule_delay_millis=400)
        )
    trace.set_tracer_provider(provider)
    _PROVIDER = provider
    _TRACER = trace.get_tracer(resolved_service)
    _PROPAGATOR = TraceContextTextMapPropagator()
    atexit.register(_shutdown_otel)
    return _TRACER


def extract_parent_context(carrier: Mapping[str, str] | None) -> Any:
    if not _OTEL_AVAILABLE or not carrier:
        return None
    init_core_tracer()
    if _PROPAGATOR is None:
        return None
    lowered = {str(k).lower(): str(v) for k, v in carrier.items() if v is not None}
    return _PROPAGATOR.extract(carrier=lowered)


def format_current_traceparent() -> str:
    if not _OTEL_AVAILABLE:
        return ""
    init_core_tracer()
    if _PROPAGATOR is None:
        return ""
    carrier: dict[str, str] = {}
    _PROPAGATOR.inject(carrier=carrier)
    return carrier.get("traceparent", "")


def current_trace_id_hex() -> str:
    if not _OTEL_AVAILABLE:
        return ""
    span = trace.get_current_span()
    if span is None:
        return ""
    ctx = span.get_span_context()
    if not ctx or not ctx.is_valid:
        return ""
    return f"{ctx.trace_id:032x}"


@contextlib.contextmanager
def start_span(
    name: str,
    attributes: Mapping[str, Any] | None = None,
    parent_context: Any = None,
) -> Iterator[Any]:
    tracer = init_core_tracer()
    if tracer is None or not _OTEL_AVAILABLE:
        yield None
        return

    with tracer.start_as_current_span(name, context=parent_context) as span:
        if attributes:
            for k, v in attributes.items():
                if v is not None:
                    span.set_attribute(k, v)
        yield span
