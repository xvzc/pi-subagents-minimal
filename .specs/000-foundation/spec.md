# Specification: Foundation and Configuration

## Public Surface

- **S1:** Extension activation registers exactly `subagent_call`, `subagent_output`, `subagent_list`, and `subagent_status`.
- **S2:** Session IDs begin with `ses_`.
- **S3:** An ID outside the session namespace is never valid where a session ID is required.
- **S4:** Every failed operation is representable as `{ error: { code: string, message: string } }` and must not crash the parent session.

## Shared States

- **S5:** Shared run states are `queued`, `running`, `completed`, `failed`, `stopped`, and `aborted`.
- **S6:** Active records have no `completed_at`; terminal records have one.
- **S7:** Reported status, output, and usage must be observed rather than fabricated.

## Configuration

Effective configuration:

```ts
interface MinimalSubagentsConfig {
  historyRetentionDays: number;
  defaultModel?: string;
  defaultThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
```

- **S8:** Configuration loads once during activation in this order: built-in defaults, valid global fields, valid project fields.
- **S9:** Missing files are silent.
- **S10:** Invalid JSON or a non-object root warns and contributes no overrides.
- **S11:** Known fields are validated independently; an invalid field warns and leaves its lower-precedence value unchanged.
- **S12:** Unknown fields warn and are ignored.
- **S13:** Project values override global values by field, not by replacing the object.
- **S14:** The numeric field `historyRetentionDays` must be a safe integer with range 1–3650.
- **S15:** `defaultModel`, when present, is a non-empty trimmed string.
- **S16:** `defaultThinking`, when present, is one of the seven values in C5.

## Shared Error Codes

- **S17:** Initial stable codes are:
  - `INVALID_ARGUMENT`
  - `AGENT_NOT_FOUND`
  - `MODEL_NOT_FOUND`
  - `THINKING_LEVEL_UNSUPPORTED`
  - `EXTENSION_LOAD_FAILED`
  - `SESSION_NOT_FOUND`
  - `SESSION_BUSY`
  - `SESSION_NOT_RUNNING`
  - `SESSION_NOT_RESUMABLE`
  - `INTERNAL_ERROR`

## Acceptance Criteria

- **A1:** Booting the extension registers exactly the four named tools.
- **A2:** With no files, effective configuration is retention `7` with absent model/thinking defaults.
- **A3:** Valid global values apply and valid project fields override them independently.
- **A4:** Missing, malformed, unknown, and invalid configuration inputs warn or remain silent exactly as specified without aborting activation.
- **A5:** Shared ID namespaces and error envelopes are enforced by contract tests.
