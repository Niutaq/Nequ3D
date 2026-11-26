package main

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// FaithfulnessCheck represents a single DeepEval-style rubric check against ground-truth JSON telemetry.
type FaithfulnessCheck struct {
	ID     string  `json:"id"`
	Label  string  `json:"label"`
	Passed bool    `json:"passed"`
	Score  float64 `json:"score"`
	Detail string  `json:"detail"`
}

// FaithfulnessReport scores local LLM renovation advice against deterministic OpenUSD/NTC telemetry.
type FaithfulnessReport struct {
	Score              float64             `json:"score"`
	ScorePct           int                 `json:"score_pct"`
	Verdict            string              `json:"verdict"` // "faithful" | "warning" | "hallucinated"
	Model              string              `json:"model,omitempty"`
	MatchedFacts       []string            `json:"matched_facts"`
	UnsupportedNumbers []string            `json:"unsupported_numbers,omitempty"`
	Checks             []FaithfulnessCheck `json:"checks"`
}

var (
	// Strips technical tokens like "3D", "2D", "3DGS", "2DGS", "SHA-256", "sha256", "Gemma 2B", "Llama 3", "v3.1"
	nonMetricTokenRe = regexp.MustCompile(`(?i)\b(?:[23]d(?:gs)?|sha-?256|gemma\s*2b|llama\s*3|mistral\s*7b|v\d+(?:\.\d+)*)\b`)
	// Strips numbered markdown list prefixes at start of lines ("1. ", "2) ")
	listIndexPrefixRe = regexp.MustCompile(`(?m)^\s*\d+[.)]\s+`)
	// Captures grouped integers ("18 420", "18,420") or decimals/integers ("87.5", "0.9612", "450")
	numberTokenRe = regexp.MustCompile(`\d{1,3}(?:[ \x{00a0},]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`)
)

func evaluateAdviceFaithfulnessInternal(advice string, telemetryJSON string, model string, isPolish bool) FaithfulnessReport {
	var tel map[string]any
	_ = json.Unmarshal([]byte(telemetryJSON), &tel)
	if tel == nil {
		tel = map[string]any{}
	}

	trimmed := strings.TrimSpace(advice)
	if trimmed == "" {
		return FaithfulnessReport{
			Score:        0,
			ScorePct:     0,
			Verdict:      "hallucinated",
			Model:        model,
			MatchedFacts: []string{},
			Checks: []FaithfulnessCheck{
				{
					ID:     "non_empty",
					Label:  ternaryStr(isPolish, "Struktura odpowiedzi", "Response structure"),
					Passed: false,
					Score:  0,
					Detail: ternaryStr(isPolish, "Pusta odpowiedź modelu", "Empty model response"),
				},
			},
		}
	}

	// 1. Build ground-truth numerical allowlist from telemetry
	allowedNums := collectGroundTruthNumbers(tel)

	// Extract numbers claimed in the LLM response
	cleanedForNums := nonMetricTokenRe.ReplaceAllString(trimmed, " ")
	cleanedForNums = listIndexPrefixRe.ReplaceAllString(cleanedForNums, " ")
	rawMatches := numberTokenRe.FindAllString(cleanedForNums, -1)

	var matchedFacts []string
	var unsupported []string
	seenClaim := map[string]bool{}

	for _, rawTok := range rawMatches {
		norm := strings.NewReplacer(" ", "", "\u00a0", "", ",", "").Replace(rawTok)
		val, err := strconv.ParseFloat(norm, 64)
		if err != nil {
			continue
		}
		// Ignore tiny conversational counts 0..3 when no ground-truth match fails (e.g. "2 strefy" if 2 is in allowlist it matches anyway!)
		key := strconv.FormatFloat(val, 'f', -1, 64)
		if seenClaim[key] {
			continue
		}
		seenClaim[key] = true

		if matchesAnyGroundTruth(val, allowedNums) {
			matchedFacts = append(matchedFacts, strings.TrimSpace(rawTok))
		} else if val > 3 {
			unsupported = append(unsupported, strings.TrimSpace(rawTok))
		}
	}

	numScore := 1.0
	totalClaims := len(matchedFacts) + len(unsupported)
	if totalClaims > 0 {
		numScore = float64(len(matchedFacts)) / float64(totalClaims)
	}
	numCheck := FaithfulnessCheck{
		ID:     "numerical_precision",
		Label:  ternaryStr(isPolish, "Zgodność liczb z telemetrią", "Numerical telemetry grounding"),
		Passed: len(unsupported) == 0,
		Score:  numScore,
		Detail: buildNumDetail(len(matchedFacts), unsupported, isPolish),
	}

	// 2. NTC consistency check (active vs bypassed)
	ntcBypassed, _ := tel["ntc_bypassed"].(bool)
	lowerAdvice := strings.ToLower(trimmed)
	claimsZeroOrBypass := strings.Contains(lowerAdvice, "pominięt") ||
		strings.Contains(lowerAdvice, "brak oszczędności") ||
		strings.Contains(lowerAdvice, "bypassed") ||
		strings.Contains(lowerAdvice, "no vram savings") ||
		strings.Contains(lowerAdvice, "not applicable")

	ntcScore := 1.0
	ntcDetail := ternaryStr(isPolish, "Stan kompresji NTC zgodny z potokiem", "NTC compression state matches pipeline")
	if ntcBypassed {
		// Flag if advice invents positive % VRAM reduction while NTC was bypassed
		if strings.Contains(lowerAdvice, "redukcja vram:") && !claimsZeroOrBypass {
			ntcScore = 0.0
			ntcDetail = ternaryStr(isPolish, "Model przypisał oszczędność VRAM mimo pominięcia NTC", "Claimed VRAM reduction despite NTC bypass")
		}
	} else if claimsZeroOrBypass {
		ntcScore = 0.25
		ntcDetail = ternaryStr(isPolish, "Model opisał NTC jako pominięte mimo aktywnej kompresji", "Reported NTC bypassed despite active compression")
	}
	ntcCheck := FaithfulnessCheck{
		ID:     "ntc_consistency",
		Label:  ternaryStr(isPolish, "Spójność statusu RTX NTC", "RTX NTC status consistency"),
		Passed: ntcScore >= 0.9,
		Score:  ntcScore,
		Detail: ntcDetail,
	}

	// 3. Zone grounding check (when zones exist in telemetry)
	zones := extractZoneNames(tel)
	zoneScore := 1.0
	zoneDetail := ternaryStr(isPolish, "Brak stref w skanie lub poprawne odniesienie", "No zones in scan or grounded reference")
	if len(zones) > 0 {
		mentioned := 0
		for _, z := range zones {
			if z != "" && strings.Contains(lowerAdvice, strings.ToLower(z)) {
				mentioned++
			}
		}
		if mentioned > 0 {
			zoneScore = 1.0
			zoneDetail = ternaryStr(
				isPolish,
				"Uwzględniono strefy z twin_manifest ("+strconv.Itoa(mentioned)+"/"+strconv.Itoa(len(zones))+")",
				"Referenced twin_manifest zones ("+strconv.Itoa(mentioned)+"/"+strconv.Itoa(len(zones))+")",
			)
		} else {
			// General mesh advice prompt doesn't always receive zone list unless agent/manifest context is active
			zoneScore = 0.85
			zoneDetail = ternaryStr(isPolish, "Podsumowanie ogólne (bez nazw stref)", "General asset summary (zone-agnostic)")
		}
	}
	zoneCheck := FaithfulnessCheck{
		ID:     "zone_grounding",
		Label:  ternaryStr(isPolish, "Zakotwiczenie w strefach OpenUSD", "OpenUSD zone grounding"),
		Passed: zoneScore >= 0.8,
		Score:  zoneScore,
		Detail: zoneDetail,
	}

	// 4. Actionable bullet structure check
	bulletCount := 0
	for _, line := range strings.Split(trimmed, "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "- ") || strings.HasPrefix(l, "* ") || strings.HasPrefix(l, "• ") || regexp.MustCompile(`^\d+\.`).MatchString(l) {
			bulletCount++
		}
	}
	structScore := 1.0
	if bulletCount < 2 {
		structScore = 0.65
	}
	structCheck := FaithfulnessCheck{
		ID:     "structural_completeness",
		Label:  ternaryStr(isPolish, "Kompletność strukturalna", "Structural completeness"),
		Passed: structScore >= 0.9,
		Score:  structScore,
		Detail: ternaryStr(
			isPolish,
			"Punkty raportu: "+strconv.Itoa(bulletCount),
			"Structured report points: "+strconv.Itoa(bulletCount),
		),
	}

	// Weighted score: numerical precision (45%) + NTC consistency (30%) + zone grounding (15%) + structure (10%)
	total := 0.45*numScore + 0.30*ntcScore + 0.15*zoneScore + 0.10*structScore
	total = math.Max(0, math.Min(1, total))
	pct := int(math.Round(total * 100))

	verdict := "faithful"
	if pct < 65 || ntcScore == 0 {
		verdict = "hallucinated"
	} else if pct < 85 || len(unsupported) > 0 {
		verdict = "warning"
	}

	if matchedFacts == nil {
		matchedFacts = []string{}
	}
	return FaithfulnessReport{
		Score:              math.Round(total*1000) / 1000,
		ScorePct:           pct,
		Verdict:            verdict,
		Model:              model,
		MatchedFacts:       matchedFacts,
		UnsupportedNumbers: unsupported,
		Checks:             []FaithfulnessCheck{numCheck, ntcCheck, zoneCheck, structCheck},
	}
}

func collectGroundTruthNumbers(tel map[string]any) []float64 {
	var nums []float64
	addFloat := func(v float64) {
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			nums = append(nums, v)
		}
	}
	addAny := func(v any) {
		switch x := v.(type) {
		case float64:
			addFloat(x)
		case int:
			addFloat(float64(x))
		case int64:
			addFloat(float64(x))
		case string:
			clean := strings.TrimSpace(strings.TrimSuffix(x, "%"))
			if f, err := strconv.ParseFloat(clean, 64); err == nil {
				addFloat(f)
			}
		}
	}

	for _, k := range []string{
		"total_vertices", "total_faces", "mesh_count", "texture_count",
		"material_count", "total_prim_count", "avg_psnr_db", "avg_ssim",
		"vram_reduction", "bpp",
	} {
		addAny(tel[k])
	}
	if tm, ok := tel["twin_manifest"].(map[string]any); ok {
		addAny(tm["zone_count"])
		addAny(tm["prim_count"])
		addAny(tm["meters_per_unit"])
	}
	if zones, ok := tel["zones"].([]any); ok {
		addFloat(float64(len(zones)))
		for _, z := range zones {
			if zm, ok := z.(map[string]any); ok {
				addAny(zm["prim_count"])
			}
		}
	}
	if files, ok := tel["ntc_compressed_files"].([]any); ok {
		var savedSum, redSum float64
		var redCount int
		for _, f := range files {
			if fm, ok := f.(map[string]any); ok {
				addAny(fm["raw_vram_mb"])
				addAny(fm["ntc_vram_mb"])
				addAny(fm["vram_saved_mb"])
				addAny(fm["psnr_db"])
				addAny(fm["ssim"])
				addAny(fm["vram_reduction"])
				if sv, ok := fm["vram_saved_mb"].(float64); ok {
					savedSum += sv
				}
				if rs, ok := fm["vram_reduction"].(string); ok {
					if rv, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(rs), "%"), 64); err == nil {
						redSum += rv
						redCount++
					}
				}
			}
		}
		if savedSum > 0 {
			addFloat(savedSum)
		}
		if redCount > 0 {
			addFloat(redSum / float64(redCount))
		}
	}
	// Common bitrates (32bpp raw vs 1..8 target bpp)
	addFloat(32)
	return nums
}

func matchesAnyGroundTruth(claimed float64, truth []float64) bool {
	for _, gt := range truth {
		diff := math.Abs(claimed - gt)
		// Allow rounding tolerance (e.g. 87.5% vs 87.48%, or 36.4 dB vs 36.42 dB)
		tol := math.Max(0.15, math.Abs(gt)*0.015)
		if diff <= tol {
			return true
		}
	}
	return false
}

func extractZoneNames(tel map[string]any) []string {
	var out []string
	if zones, ok := tel["zones"].([]any); ok {
		for _, z := range zones {
			if zm, ok := z.(map[string]any); ok {
				if lbl, _ := zm["label"].(string); lbl != "" {
					out = append(out, lbl)
				}
				if id, _ := zm["id"].(string); id != "" {
					out = append(out, id)
				}
			}
		}
	}
	return out
}

func buildNumDetail(matched int, unsupported []string, isPolish bool) string {
	if len(unsupported) == 0 {
		if isPolish {
			return "Potwierdzono faktów liczbowych: " + strconv.Itoa(matched) + " (0 halucynacji)"
		}
		return "Verified numerical facts: " + strconv.Itoa(matched) + " (0 hallucinations)"
	}
	if isPolish {
		return "Niepotwierdzone liczby w tekście: " + strings.Join(unsupported, ", ")
	}
	return "Unverified numbers in response: " + strings.Join(unsupported, ", ")
}

func ternaryStr(cond bool, a string, b string) string {
	if cond {
		return a
	}
	return b
}

// EvaluateAdviceFaithfulness evaluates LLM advice text against JSON telemetry and returns a JSON FaithfulnessReport.
func (a *App) EvaluateAdviceFaithfulness(adviceText string, telemetryJSON string, language string) (string, error) {
	isPl := strings.EqualFold(strings.TrimSpace(language), "pl") || strings.EqualFold(strings.TrimSpace(language), "Polish")
	rep := evaluateAdviceFaithfulnessInternal(adviceText, telemetryJSON, "", isPl)
	raw, err := json.Marshal(rep)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
