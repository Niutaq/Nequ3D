package main

import "testing"

func TestFaithfulnessEvaluatorDetectsGroundedVsHallucinatedNumbers(t *testing.T) {
	telemetry := `{
		"total_vertices": 24500,
		"total_faces": 48100,
		"mesh_count": 3,
		"texture_count": 2,
		"total_prim_count": 14,
		"ntc_bypassed": false,
		"avg_psnr_db": 36.42,
		"avg_ssim": 0.9612,
		"ntc_compressed_files": [{"vram_reduction": "87.5%", "vram_saved_mb": 14.0}],
		"zones": [{"id": "kitchen", "label": "Kitchen", "prim_count": 3}]
	}`

	grounded := "- **Model:** Flat.usdz — skan 3D wnętrza Kitchen\n" +
		"- **Geometria:** 24 500 wierzchołków, 48 100 wielokątów, 3 siatki i 2 tekstury (14 elementów sceny)\n" +
		"- **Pamięć VRAM:** Kompresja NTC aktywna, redukcja VRAM: 87.5% (PSNR: 36.42 dB, SSIM: 0.9612)"

	repOk := evaluateAdviceFaithfulnessInternal(grounded, telemetry, "gemma:2b", true)
	if repOk.Verdict != "faithful" || repOk.ScorePct < 95 || len(repOk.UnsupportedNumbers) != 0 {
		t.Fatalf("expected faithful report >=95%%, got %+v", repOk)
	}

	hallucinated := "- **Model:** Flat.usdz\n" +
		"- **Geometria:** 999 123 wierzchołków oraz 777 000 wielokątów\n" +
		"- **Pamięć VRAM:** Kompresja NTC: Pominięta (brak oszczędności VRAM)."

	repBad := evaluateAdviceFaithfulnessInternal(hallucinated, telemetry, "gemma:2b", true)
	if repBad.ScorePct >= 75 || len(repBad.UnsupportedNumbers) < 2 {
		t.Fatalf("expected hallucination penalty and unsupported numbers, got %+v", repBad)
	}
}
