// Keep in sync with web/components/nativeAgentTerminal/nativeAgentTerminal.ts.
// This terminal-ID convention only disables provider heuristics/wrappers; it
// does not grant permissions or identify a provider adapter.
export function isNativeAgentTerminal(terminalId: string): boolean {
  return terminalId.startsWith("native-agent-");
}
