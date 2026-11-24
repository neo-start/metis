# Router account binding and failure diagnostics

The independent, tool-free Router must use the selected provider slot's configured
binary and home directory, including the primary `codex` slot. A primary slot is
not necessarily the CLI's default `~/.codex` account. Explicit request provider
options retain precedence. Routing must not select another account or model as a
failure fallback.

Codex `turn.failed` messages are redacted with the existing provider log sanitizer
and bounded before being included in server-side text-generation errors. The
public Router failure remains generic; credentials and raw output are not exposed
in chat. A failure before planning completes is not proof that a worker was
created. Check Router receipts and the corresponding orchestration records before
retrying, and never replay old user requests during recovery.

## Verification boundary

Focused provider-generation tests cover primary-slot binding, existing independent
slots, selected-model preservation, terminal event handling, and error redaction.
These checks do not establish live account authentication, quota, model availability,
Feishu delivery, or safe production restart. Operational recovery must establish
those separately. Do not infer full recovery from a successful Feishu connection.
