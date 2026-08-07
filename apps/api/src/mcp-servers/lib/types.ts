/**
 * Shared types for MCP group proxy tool entries.
 */

export interface ToolEntry {
  name: string // "backend:tool_name" (full name)
  originalName: string // "tool_name" (without prefix)
  description: string
  inputSchema: object
  backend: string
}
