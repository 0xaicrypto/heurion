# KB Evolution Phase 2 — TDD Test Plan

This document covers the next three work items after the initial Query Router / KB commands / Gap MVP:

1. Sidecar output feedback into memory (user-triggered, no auto-ingestion)
2. Knowledge Gap UI improvements (pagination, filtering, auto-suggest, dashboard)
3. Telemetry / metrics for Query Router, KB commands, and gap resolution

All features are designed to be **low cost** — no mandatory LLM calls on hot paths.

---

## 1. Sidecar Output Feedback

### Goal
Allow users (or the UI) to send MedSci-Sidecar outputs back into the knowledge base. By default we only return extraction candidates; actual writes require `saveAll: true`.

### API

```
POST /api/v1/knowledge/sidecar/feedback
{
  "output": "...report/summary text...",
  "outputType": "report" | "summary" | "analysis",
  "saveAll": false | true,
  "sourceId": "optional-sidecar-run-id"
}
```

Response:

```json
{
  "candidates": [
    { "content": "EGFR exon 19 deletion detected", "category": "fact", "importance": 5, "confidence": 0.92 }
  ],
  "saved": [
    { "id": "fact-id", "content": "..." }
  ],
  "gaps": []
}
```

### Tests

#### Unit: `sidecar-feedback.service.ts`

1. **Extract facts from plain report text**
   - Input: report with multiple findings.
   - Expect: candidate facts for each high-confidence sentence.

2. **Ignore low-value sentences**
   - Input: report with headers, filler, and uncertainty.
   - Expect: low or zero confidence for filler; high confidence for numeric/clinical findings.

3. **Save all candidates when `saveAll: true`**
   - Input: output + `saveAll: true`.
   - Expect: candidates written to `FactsStore`; returned `saved` length > 0.

4. **Do not save facts when `saveAll: false`**
   - Expect: returned candidates but empty `saved`.

5. **LLM extractor fallback is optional**
   - When no LLM provided, rule-based extractor still returns candidates.

#### API: `sidecar-feedback.test.ts`

6. **POST without auth returns 401** (authGuard already covers, but verify).

7. **POST requires `output`**
   - Status 400, error `"output required"`.

8. **POST with `saveAll: false` returns candidates and does not persist facts**
   - Verify by loading user context facts count unchanged.

9. **POST with `saveAll: true` persists facts**
   - Verify facts count increased; fact sourceType is `"sidecar"`.

---

## 2. Knowledge Gap UI Improvements

### Goal
Make the gap list usable in a real UI: pagination, search, source filtering, auto-suggest answers, and a dashboard.

### API Additions

```
GET /api/v1/knowledge/gaps?status=open&source=chat&q=EGFR&page=1&pageSize=10&sortBy=createdAt&sortOrder=desc
GET /api/v1/knowledge/gaps/dashboard
GET /api/v1/knowledge/gaps/:id/suggest
```

### Tests

#### Unit / Service: `knowledge-gap.service.ts`

1. **Paginated list returns correct page metadata**
   - Create 15 gaps; pageSize 10, page 1 → 10 gaps, total 15, totalPages 2.

2. **Search filters by substring (case-insensitive)**
   - Gaps with content "EGFR mutation" and "KRAS mutation"; q="EGFR" → only EGFR gap.

3. **Source filter works**
   - Create gaps from `chat` and `sidecar`; filter `source=sidecar` → only sidecar.

4. **Sort by updatedAt ascending**
   - Update one gap later; sort order changes.

5. **Suggest answer returns relevant facts/knowledge**
   - Seed fact "EGFR exon 19 deletion". Gap content "EGFR mutation prevalence" → suggestion includes that fact.

6. **Suggest answer returns empty for unknown gap**
   - Status 404.

7. **Dashboard stats are accurate**
   - Create gaps in open/answered/ignored; assert counts and resolution rate.

#### API: `knowledge-gap-ui.test.ts`

8. **GET /gaps with pagination shape**
   - Response contains `gaps` and `pagination`.

9. **GET /gaps/dashboard returns stats**
   - Keys: `total`, `open`, `answered`, `ignored`, `bySource`, `resolutionRate`.

10. **GET /gaps/:id/suggest returns suggestions**
    - Response contains `suggestions: string[]`.

11. **Existing endpoints remain backward-compatible**
    - Answering a gap still returns `status`, `answerText`, `answerId`.

---

## 3. Telemetry / Metrics

### Goal
Record cheap, structured events for the three high-value areas and expose a dashboard.

### Events

| Category     | Actions                                  | Metadata examples                         |
|--------------|------------------------------------------|-------------------------------------------|
| `router`     | `sql`, `vector`, `file`, `knowledge_command`, `mixed` | `ruleHit`, `llmFallback`, `llmCalls`       |
| `kb_command` | `kb_search`, `kb_remember`, `kb_summarize`, `kb_gaps` | `itemCount`, `hadError`                    |
| `gap`        | `created`, `answered`, `ignored`, `auto_resolved`     | `source`, `autoResolved`                   |

### API

```
POST /api/v1/knowledge/telemetry/record   (internal use; also auto-recorded)
GET  /api/v1/knowledge/telemetry/dashboard
```

### Tests

#### Unit: `telemetry.service.ts`

1. **Record and query events**
   - Record router event; query returns it.

2. **In-memory service works without DB**
   - Used in unit tests.

3. **Dashboard aggregates by category/action**
   - Multiple router intents and KB commands; dashboard totals correct.

4. **Router fallback rate calculation**
   - 3 rule hits + 2 LLM fallbacks → fallback rate 0.4, hit rate 0.6.

#### Integration: `telemetry.test.ts`

5. **Chat turn records a router event**
   - Post chat message; assert telemetry dashboard shows router intent count increased.

6. **KB command records a kb_command event**
   - Send "记住：..."; assert kb_command count increased.

7. **Answering a gap records a gap event**
   - POST answer; assert `gap.answered` count increased.

8. **Telemetry endpoint requires auth**
   - GET dashboard without token → 401.

---

## Test File Mapping

| Feature              | Unit Tests                                   | API/Integration Tests                  |
|----------------------|----------------------------------------------|----------------------------------------|
| Sidecar feedback     | `tests/sidecar-feedback.test.ts`             | same file (uses app inject)            |
| Gap UI improvements  | `tests/knowledge-gap-ui.test.ts`             | same file                              |
| Telemetry            | `tests/telemetry.test.ts`                    | same file                              |

## Acceptance Criteria

- `npm test` passes with new tests.
- Regression script `scripts/regression-test.sh` passes (except pre-existing 5.1 Gemini Vision failure).
- No new mandatory LLM calls on hot paths.
- All telemetry writes are best-effort and do not fail the request.
