// Native agent terminals use ordinary task-owned terminal IDs and APIs. This
// prefix is a presentation/lifecycle convention, never an authorization claim.
// Keep in sync with server/terminal/nativeAgentTerminal.ts (no new wire schema).
export const NATIVE_AGENT_TERMINAL_PREFIX = "native-agent-";

export function isNativeAgentTerminal(terminalId: string): boolean {
  return terminalId.startsWith(NATIVE_AGENT_TERMINAL_PREFIX);
}

/** The user supplies a complete command for their shell; never interpolate cwd,
 * task text, environment, arguments, or model settings into that command. */
export function nativeAgentTerminalCommandError(command: string): string | null {
  if (!command.trim()) return "Enter the CLI command you want to run.";
  if (command.length > 8_000) return "Keep the command under 8,000 characters.";
  if (
    Array.from(command).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
    })
  )
    return "Use one line without terminal control characters.";
  return null;
}
