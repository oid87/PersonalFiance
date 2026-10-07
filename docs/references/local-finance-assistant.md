# Future local finance assistant — deployment proposal

Status: **PLAN ONLY, not installed or implemented**. Official documentation was
read on 2026-10-07; no model download, API request or provider call occurred.
The Mac mini's assumed M1 / 8 GB RAM / 256 GB storage is **not hardware verified**.

## Model candidates and evidence

| Candidate | Verified source facts | Proposed role |
| --- | --- | --- |
| Qwen3-4B-Instruct-2507, Q4_K_M | Qwen's [model card](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507) identifies 4.0B parameters, Apache-2.0 and non-thinking output. The exact [Ollama tag](https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M) lists Q4_K_M and about 2.5 GB weights. | Primary candidate for grounded Traditional Chinese summaries; suitability on this Mac is unmeasured |
| Phi-4-mini-instruct | Microsoft's [model card](https://huggingface.co/microsoft/Phi-4-mini-instruct) identifies 3.8B parameters and MIT, includes Chinese, and explains the primarily English training/performance limitation. | Backup candidate; Traditional Chinese quality requires local evaluation |

These are roughly 4B candidates for the requested approximately-3B class. Weight
file size is not runtime RAM. Context/KV cache, runtime buffers, macOS and other
applications consume additional memory. No throughput, latency or 8 GB fit is
claimed. Start by verifying actual hardware, free disk and runtime memory.

Initial proposed operating envelope: 4K context, one loaded model and one
concurrent request. These are project choices, not verified hardware results.

## Data and API boundary

The deterministic existing pipeline owns every calculation, financial rule,
threshold, missing-data status and source record. The model receives a compact
read-only snapshot and returns grounded summaries in 繁體中文. It may request
only allowlisted read-only queries with bounded parameters; it receives no
arbitrary shell/SQL, filesystem write tools, trading actions or acquisition tools.

Proposed flow, not an implemented interface:

```text
committed/approved local snapshot
  → deterministic allowlisted query + calculated facts + source IDs
  → compact model request with JSON schema
  → JSON/schema validation + source-ID check + exact fact validation
  → display Traditional Chinese summary, or deterministic failure fallback
```

Every numeric assertion must reference a fact ID and match its value/unit/period;
the application formats the original facts. Reject unsupported citations,
fabricated missing values, changed thresholds or new calculations. Free-text
claims need grounding review as well; schema correctness alone is not truth.
Timeout, invalid JSON, mismatched numbers/sources or missing inputs return the
existing deterministic facts plus an explicit unavailable-summary status.

Ollama documents a local [OpenAI-compatible interface](https://docs.ollama.com/api/openai-compatibility)
and [schema-constrained structured outputs](https://docs.ollama.com/capabilities/structured-outputs).
For the compatible interface, context size is configured in a derived model's
Modelfile, not through a generic OpenAI request field. Native `/api/chat` uses
`format` for a schema; the compatible chat interface uses `response_format`.
Validate the installed version's behavior before choosing one interface.

API must bind to localhost only, with no public listener or permissive browser
origin setting. A Cloud-hosted UI cannot directly use the Mac's localhost API.
First evaluate a local UI/adapter on the Mac; any tunnel, authenticated remote
bridge, hosting change or shared endpoint is a separate future implementation
requiring authorization and verification. Never expose the private ETF payload
through a public repository, site or remote endpoint.

## Later implementation gates

1. Verify Mac hardware and supported local runtime; approve a model download and
   exact tag/version. Preserve the primary/backup choice as evaluation candidates.
2. Configure the selected runtime for the initial context/concurrency envelope
   using its official controls. Measure resident memory, swap pressure and latency
   with representative bounded snapshots before expanding context.
3. Implement read-only query allowlist and provenance-bearing deterministic
   snapshots, then JSON/source/numeric validation and failure fallback.
4. Evaluate Traditional Chinese finance summaries on approved existing facts,
   stale/null/partial inputs and malformed/unsupported responses. The model does
   not decide investment rules or complete missing evidence.
5. Verify localhost binding and local UI access. Any Cloud-to-Mac remote access
   is outside this proposal's implemented scope.

No installation commands are offered as already executed. Later model setup and
adapter/remote access are pending verified implementation, not dashboard features
completed by this Cloud task.

## Proposed read-only adapter contract — specification only

The following local interface is not running and is not an installation request.
The future adapter binds to loopback; paths are project design choices, not Ollama
endpoints. It must reject write methods and arbitrary URLs/paths/SQL/shell input.

| Read operation | Bounded inputs | Response / failure contract |
| --- | --- | --- |
| `GET /v1/status` | None | schemaVersion, installed model identity, snapshot ID/asOf, available/unavailable and reason; no hardware-fit claim |
| `GET /v1/facts` | Approved snapshot ID, allowlisted ticker/view ID and approved period; bounded count | Existing calculated fact IDs with exact value, unit, period, source IDs and missing/partial status; no new calculations |
| `GET /v1/sources` | Source IDs already referenced by the selected snapshot | Approved provenance records and references; no arbitrary network fetch |

A summary request remains internal to the local UI/adapter. The model's structured
result is `{schemaVersion:1,status:"available"|"unavailable",snapshotId,locale:"zh-TW",claims:[{text,factIds,sourceIds}],reason}`.
Every claim must refer to the provided snapshot and approved source/fact IDs.
Numbers, units, signs, periods and completeness are checked against deterministic
facts; renderer uses the original fact values. Missing/stale/partial facts remain
explicit. Unsupported claims, invalid schema, timeout or source/numeric mismatch
return unavailable plus the deterministic facts; no retry may fabricate values.

This plan adds no Cloud-to-Mac call, credential, model process, writable API or
public access. Private ETF data remains outside public artifacts and services.
