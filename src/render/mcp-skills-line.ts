import type { RenderContext } from '../types.js';
import { cyan, magenta, dim } from './colors.js';

export function renderMcpSkillsLine(ctx: RenderContext): string | null {
  const parts: string[] = [];

  // MCP servers
  if (ctx.mcpNames && ctx.mcpNames.length > 0) {
    const mcpList = ctx.mcpNames.join(', ');
    parts.push(`${magenta('MCP:')} ${cyan(mcpList)}`);
  }

  // Skills used in this session (from tools with name 'Skill')
  const skillTools = ctx.transcript.tools.filter(t => t.name === 'Skill');
  if (skillTools.length > 0) {
    const skillTargets = [...new Set(skillTools.map(t => t.target).filter(Boolean))];
    if (skillTargets.length > 0) {
      parts.push(`${magenta('Skills:')} ${cyan(skillTargets.join(', '))}`);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' | ');
}
