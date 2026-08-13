/** Canonical host-side tool sources. */
export type ToolSource = 'local' | 'mcp' | 'provider';
export type ToolRisk = 'read' | 'write' | 'external_side_effect' | 'destructive' | 'maintenance';
export type ToolPhase = 'reply' | 'memory_commit' | 'proactive' | 'maintenance' | 'admin';

export interface ToolExecutionContext {
  phase: ToolPhase;
  signal?: AbortSignal;
  batchId?: string;
  revision?: number;
}

export interface ToolDescriptor<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: ToolSource;
  serverId?: string;
  modelName?: string;
  remoteName?: string;
  authorized?: boolean;
  risk: ToolRisk;
  phases: ToolPhase[];
  authorize?: (phase: ToolPhase) => boolean;
  handler: (input: I, context?: ToolExecutionContext) => Promise<O>;
}

export interface PublicToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AdminToolDescriptor extends PublicToolDescriptor {
  modelName?: string;
  remoteName?: string;
  source: ToolSource;
  serverId?: string;
  risk: ToolRisk;
  phases: ToolPhase[];
  authorized: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();

  register(tool: ToolDescriptor): void {
    validateToolDescriptor(tool);
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  replaceSource(sourceId: string, tools: ToolDescriptor[]): void {
    this.removeSource(sourceId);
    for (const tool of tools) this.register(tool);
  }

  removeSource(sourceId: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.serverId === sourceId) this.tools.delete(name);
    }
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  require(name: string): ToolDescriptor {
    const tool = this.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool;
  }

  getByModelName(name: string): ToolDescriptor | undefined {
    return [...this.tools.values()].find((tool) => (tool.modelName ?? tool.name) === name);
  }

  setAuthorization(name: string, authorized: boolean): void {
    this.require(name).authorized = authorized;
  }

  list(): PublicToolDescriptor[] {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  listForAdmin(): AdminToolDescriptor[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      ...(tool.modelName ? { modelName: tool.modelName } : {}),
      ...(tool.remoteName ? { remoteName: tool.remoteName } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      source: tool.source,
      ...(tool.serverId ? { serverId: tool.serverId } : {}),
      risk: tool.risk,
      phases: [...tool.phases],
      authorized: tool.authorized === true
    }));
  }

  listForPhase(phase: ToolPhase): ToolDescriptor[] {
    return [...this.tools.values()].filter((tool) =>
      tool.phases.includes(phase) && (tool.authorize === undefined || tool.authorize(phase))
    );
  }

  size(): number {
    return this.tools.size;
  }
}

function validateToolDescriptor(tool: ToolDescriptor): void {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(tool.name)) {
    throw new Error(`invalid canonical tool name: ${tool.name}`);
  }
  if (!tool.description.trim()) throw new Error(`tool description is empty: ${tool.name}`);
  if (tool.inputSchema.type !== undefined && tool.inputSchema.type !== 'object') {
    throw new Error(`tool input schema must be an object: ${tool.name}`);
  }
  if (tool.phases.length === 0) throw new Error(`tool has no allowed phases: ${tool.name}`);
  if (tool.source === 'mcp' && !tool.serverId) throw new Error(`MCP tool is missing serverId: ${tool.name}`);
  if (tool.modelName !== undefined && !/^[a-z][a-z0-9]*(?:[_-]+[a-z0-9]+)*$/u.test(tool.modelName)) {
    throw new Error(`invalid model tool name: ${tool.modelName}`);
  }
}
