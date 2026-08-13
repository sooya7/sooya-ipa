import { describe, expect, it } from 'vitest';
import { ToolRegistry, type ToolDescriptor } from './registry.js';

const descriptor = (overrides: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name: 'ombre.breath',
  description: 'Surface a memory.',
  inputSchema: { type: 'object' },
  source: 'mcp',
  serverId: 'ombre',
  risk: 'read',
  phases: ['reply', 'proactive'],
  handler: async () => 'ok',
  ...overrides
});

describe('ToolRegistry', () => {
  it('rejects duplicate canonical names and preserves source metadata', () => {
    const registry = new ToolRegistry();
    registry.register(descriptor());
    expect(() => registry.register(descriptor())).toThrow('tool already registered: ombre.breath');
    expect(registry.get('ombre.breath')).toMatchObject({
      source: 'mcp',
      serverId: 'ombre',
      risk: 'read',
      phases: ['reply', 'proactive']
    });
  });

  it('can replace one server namespace without affecting another', () => {
    const registry = new ToolRegistry();
    registry.register(descriptor({ name: 'github.search_code', serverId: 'github' }));
    registry.register(descriptor({ name: 'ombre.breath' }));
    expect(registry.list().map((item) => item.name)).toEqual(['github.search_code', 'ombre.breath']);
    registry.replaceSource('github', [descriptor({ name: 'github.search_issues', serverId: 'github' })]);
    expect(registry.get('github.search_code')).toBeUndefined();
    expect(registry.get('github.search_issues')).toBeDefined();
    expect(registry.get('ombre.breath')).toBeDefined();
  });

  it('filters by phase and rejects unknown tools', () => {
    const registry = new ToolRegistry();
    registry.register(descriptor());
    registry.register(descriptor({
      name: 'ombre.hold',
      risk: 'write',
      phases: ['memory_commit']
    }));
    expect(registry.listForPhase('reply').map((tool) => tool.name)).toEqual(['ombre.breath']);
    expect(registry.listForPhase('memory_commit').map((tool) => tool.name)).toEqual(['ombre.hold']);
    expect(() => registry.require('unknown.tool')).toThrow('unknown tool: unknown.tool');
  });

  it('supports model names, authorization changes, source removal, and safe admin metadata', () => {
    const registry = new ToolRegistry();
    registry.register(descriptor({ modelName: 'ombre__breath', remoteName: 'breath', authorized: false }));
    expect(registry.getByModelName('ombre__breath')?.name).toBe('ombre.breath');
    registry.setAuthorization('ombre.breath', true);
    const admin = registry.listForAdmin();
    expect(admin).toEqual([expect.objectContaining({
      name: 'ombre.breath',
      modelName: 'ombre__breath',
      remoteName: 'breath',
      authorized: true
    })]);
    expect(admin[0]).not.toHaveProperty('handler');
    expect(admin[0]!.phases).not.toBe(registry.require('ombre.breath').phases);
    expect(registry.size()).toBe(1);
    registry.removeSource('ombre');
    expect(registry.size()).toBe(0);
  });

  it.each([
    [descriptor({ name: 'invalid' }), 'invalid canonical tool name'],
    [descriptor({ description: '  ' }), 'tool description is empty'],
    [descriptor({ inputSchema: { type: 'string' } }), 'tool input schema must be an object'],
    [descriptor({ phases: [] }), 'tool has no allowed phases'],
    [descriptor({ serverId: undefined }), 'MCP tool is missing serverId'],
    [descriptor({ modelName: 'Invalid.Name' }), 'invalid model tool name']
  ])('rejects malformed descriptors', (tool, message) => {
    expect(() => new ToolRegistry().register(tool)).toThrow(message);
  });
});
