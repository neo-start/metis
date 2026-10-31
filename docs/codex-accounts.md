# Independent Codex accounts

Metis supports four Codex entries in Settings → Providers and the model picker:

| Entry          | Provider ID       | Default account home                  |
| -------------- | ----------------- | ------------------------------------- |
| Codex          | `codex`           | inherited `CODEX_HOME`, or `~/.codex` |
| codex-personal | `codexSecondary`  | `~/.codex-secondary`                  |
| codex-third    | `codexTertiary`   | `~/.codex-tertiary`                   |
| codex-fourth   | `codexQuaternary` | `~/.codex-quaternary`                 |

The additional entries are disabled by default. Sign in using the official Codex CLI
with a separate `CODEX_HOME`, then enable the corresponding entry. If you use another
directory, set its CODEX_HOME path in provider settings. For example:

```sh
mkdir -p ~/.codex-tertiary
CODEX_HOME=~/.codex-tertiary codex login
```

Each entry owns separate app-server processes, model discovery, plugin discovery,
configuration overlays, credentials and usage checks. Additional accounts never fall
back to the primary account's home. They reuse the existing Codex account adapter;
there is no new authentication implementation. No credentials belong in the repository.

Choose the entry before sending the first message in a new chat. An existing chat
keeps its provider ID. Changing an entry's home applies when its runtime next starts;
it can therefore affect existing chats on that entry too. Add an entry to retain the
other account bindings instead of changing an occupied entry's home.

Only primary Codex currently supports the persistent native runtime, importing native
Codex threads and consuming banked usage resets. Additional accounts use the backend
runtime. Usage and model availability come from the account's provider responses.

The implementation extends Metis's existing Synara-derived account wiring. T3 Code's
`ProviderInstanceEnvironment.ts` and `Drivers/CodexHomeLayout.ts` were inspected as
references; their different provider-instance model was not ported.
