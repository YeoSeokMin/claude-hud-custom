import type { RenderContext } from '../types.js';
import { cyan, magenta, yellow, green, dim } from './colors.js';

/**
 * Renders the project info line.
 * Format: ProjectName git:(branch*) | MCP: servers | 할일 2/5
 */
export function renderProjectLine(ctx: RenderContext): string | null {
  const parts: string[] = [];

  // Git branch + status (프로젝트명은 session-line에서 표시)
  if (ctx.gitStatus) {
    const { branch, isDirty, ahead, behind, fileStats } = ctx.gitStatus;
    let gitPart = `git:(${magenta(branch)}`;
    if (isDirty) gitPart += yellow('*');
    gitPart += ')';

    // Ahead/behind indicators
    const indicators: string[] = [];
    if (ahead > 0) indicators.push(`${green('^')}${ahead}`);
    if (behind > 0) indicators.push(`${yellow('v')}${behind}`);
    if (indicators.length > 0) {
      gitPart += ` ${indicators.join(' ')}`;
    }

    // File change stats: +added ~modified -deleted ?untracked
    if (fileStats) {
      const statsArr: string[] = [];
      if (fileStats.added > 0) statsArr.push(green(`+${fileStats.added}`));
      if (fileStats.modified > 0) statsArr.push(yellow(`~${fileStats.modified}`));
      if (fileStats.deleted > 0) statsArr.push(`${dim('-')}${fileStats.deleted}`);
      if (fileStats.untracked > 0) statsArr.push(dim(`?${fileStats.untracked}`));
      if (statsArr.length > 0) {
        gitPart += ` ${statsArr.join(' ')}`;
      }
    }

    parts.push(gitPart);
  }

  // MCP servers
  if (ctx.mcpNames && ctx.mcpNames.length > 0) {
    const mcpList = ctx.mcpNames.join(', ');
    parts.push(`MCP: ${cyan(mcpList)}`);
  }

  // Todos summary
  const todosInfo = getTodosSummary(ctx);
  if (todosInfo) {
    parts.push(todosInfo);
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' | ');
}

function getTodosSummary(ctx: RenderContext): string | null {
  const { todos } = ctx.transcript;

  if (!todos || todos.length === 0) {
    return null;
  }

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;

  if (completed === total) {
    return `${green('v')} 할일 ${completed}/${total}`;
  }

  const inProgress = todos.find((t) => t.status === 'in_progress');
  if (inProgress) {
    return `${yellow('>')} 할일 ${completed}/${total}`;
  }

  return `할일 ${completed}/${total}`;
}
