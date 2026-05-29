// Zoteus code-execution runtime bridge.
//
// In Anthropic's "code execution with MCP" pattern, the agent imports these
// typed wrappers and calls them from a sandbox instead of issuing many direct
// tool calls. Large intermediate results stay in the sandbox; only what you
// log/return reaches the model's context.
//
// Inject your sandbox's MCP bridge once at startup with setMCPCaller(...).
type Caller = (name: string, input: unknown) => Promise<any>;

let caller: Caller | null = null;

export function setMCPCaller(fn: Caller): void {
  caller = fn;
}

export async function callMCPTool(name: string, input: unknown): Promise<any> {
  if (!caller) {
    throw new Error(
      'No MCP caller configured. Call setMCPCaller(fn) with your sandbox bridge before using the Zotero wrappers.',
    );
  }
  return caller(name, input);
}
