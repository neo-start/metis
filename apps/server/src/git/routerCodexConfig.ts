import { parse, stringify } from "smol-toml";

/** Copy connection/authentication settings only. A router does not inherit MCP,
 * hooks, plugins, profiles, repository instructions or tool permissions. */
export function routerCodexConfig(source: string): string {
  const config = parse(source);
  const allowed = [
    "model_provider",
    "model_providers",
    "openai_base_url",
    "chatgpt_base_url",
    "cli_auth_credentials_store",
    "forced_login_method",
    "forced_chatgpt_workspace_id",
  ];
  return stringify(
    Object.fromEntries(allowed.filter((key) => key in config).map((key) => [key, config[key]!])),
  );
}

// See https://learn.chatgpt.com/docs/config-file/config-reference
export const ROUTER_CODEX_OVERRIDES = [
  'web_search="disabled"',
  "features.shell_tool=false",
  "features.apps=false",
  "features.hooks=false",
  "features.view_image=false",
  "features.multi_agent=false",
  "project_doc_max_bytes=0",
  "skills.include_instructions=false",
  "skills.bundled.enabled=false",
];
