import type { RenderContext } from '../types.js';
import { isLimitReached } from '../types.js';
import { getContextPercent, getBufferedPercent, getModelName, getTotalTokens } from '../stdin.js';
import { redBar, cyan, dim, magenta, red, yellow, getContextColor, greenBar, blueBar, RESET } from './colors.js';
import path from 'node:path';

const DEBUG = process.env.DEBUG?.includes('claude-hud') || process.env.DEBUG === '*';

/**
 * Renders the session lines.
 * Line 1: [Model | Plan] Tokens (Duration)
 * Line 2-4: 컨텍스트/5시간/주간 세로 정렬
 */
export function renderSessionLine(ctx: RenderContext): string {
  const model = getModelName(ctx.stdin);
  const bufferedPercent = getBufferedPercent(ctx.stdin);
  const display = ctx.config?.display;

  // Token usage display (캐시 포함 총 토큰)
  const contextSize = ctx.stdin.context_window?.context_window_size ?? 200000;
  const currentTokens = getTotalTokens(ctx.stdin);
  const tokenDisplay = `${formatTokens(currentTokens)}/${formatTokens(contextSize)}`;

  const planName = display?.showUsage !== false ? ctx.usageData?.planName : undefined;
  const modelDisplay = planName ? `${model} | ${planName}` : model;

  // Format duration in Korean
  const durationKorean = formatDurationKorean(ctx.sessionDuration);

  // LINE 1: Model + Project
  const projectName = ctx.stdin.cwd ? path.basename(ctx.stdin.cwd) : '';
  const line1 = projectName
    ? `${cyan(`[${modelDisplay}]`)} ${projectName}`
    : `${cyan(`[${modelDisplay}]`)}`;

  const lines: string[] = [line1];

  // 라벨 폭: "컨텍스트"=4글자(8칸), 퍼센트 3자리 우측정렬
  const LABEL_WIDTH = 8; // 한글 4글자 기준
  const PERCENT_WIDTH = 3;

  // LINE 2: 컨텍스트 + 토큰 + 시간 (Red)
  const contextBar = redBar(bufferedPercent);
  const contextLabel = padLabel('컨텍스트', LABEL_WIDTH);
  const contextPct = padPercent(bufferedPercent, PERCENT_WIDTH);
  const contextWarning = currentTokens >= 100000 ? ' ⚠️' : '';
  lines.push(`${contextLabel} ${contextPct} ${contextBar} ${dim(tokenDisplay)} ${dim(durationKorean)}${contextWarning}`);

  // LINE 3-4: 5시간/주간 한도 (RGB: Green/Blue)
  if (ctx.usageData?.planName && !ctx.usageData.apiUnavailable) {
    // 5시간 한도 (Green)
    const fiveHour = ctx.usageData.fiveHour ?? 0;
    const fiveHourReset = formatResetTimeKorean(ctx.usageData.fiveHourResetAt);
    const fiveHourBar = greenBar(fiveHour);
    const resetText5h = fiveHourReset ? ` ${dim(fiveHourReset)}` : '';
    const fiveHourLabel = padLabel('5시간', LABEL_WIDTH);
    const fiveHourPct = padPercent(fiveHour, PERCENT_WIDTH);
    lines.push(`${fiveHourLabel} ${fiveHourPct} ${fiveHourBar}${resetText5h}`);

    // 주간 한도 (Blue)
    const sevenDay = ctx.usageData.sevenDay ?? 0;
    const sevenDayBar = blueBar(sevenDay);
    const sevenDayReset = formatResetTimeKorean(ctx.usageData.sevenDayResetAt);
    const resetText7d = sevenDayReset ? ` ${dim(sevenDayReset)}` : '';
    const sevenDayLabel = padLabel('주간', LABEL_WIDTH);
    const sevenDayPct = padPercent(sevenDay, PERCENT_WIDTH);
    lines.push(`${sevenDayLabel} ${sevenDayPct} ${sevenDayBar}${resetText7d}`);
  } else if (ctx.usageData?.apiUnavailable) {
    const reason = ctx.usageData.failureReason ?? 'unknown';
    lines.push(yellow(`사용량 API 불가 (${reason})`));
  }

  return lines.join('\n');
}

function padLabel(label: string, width: number): string {
  // 한글은 2칸, 숫자/영문은 1칸
  const labelWidth = [...label].reduce((w, c) => w + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  const padding = Math.max(0, width - labelWidth);
  return label + ' '.repeat(padding);
}

function padPercent(percent: number, width: number): string {
  const pctStr = `${percent}%`;
  const padding = Math.max(0, width + 1 - pctStr.length); // +1 for %
  return ' '.repeat(padding) + getContextColor(percent) + pctStr + RESET;
}

function formatDurationKorean(duration: string): string {
  if (!duration) return '0분';
  // Convert "1h 30m" to "1시간 30분"
  return duration
    .replace(/(\d+)h/, '$1시간')
    .replace(/(\d+)m/, '$1분')
    .replace('<1m', '1분 미만');
}

function formatResetTimeKorean(resetAt: Date | null): string {
  if (!resetAt) return '';
  const now = new Date();
  const diffMs = resetAt.getTime() - now.getTime();
  if (diffMs <= 0) return '';

  const diffMins = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}일`);
  if (hours > 0) parts.push(`${hours}시간`);
  if (mins > 0) parts.push(`${mins}분`);

  if (parts.length === 0) return '1분 미만';
  return parts.join(' ');
}

function formatTokens(n: number): string {
  if (n >= 1000000) {
    return `${(n / 1000000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(0)}k`;
  }
  return n.toString();
}

function formatUsagePercent(percent: number | null): string {
  if (percent === null) {
    return dim('--');
  }
  const color = getContextColor(percent);
  return `${color}${percent}%${RESET}`;
}

function formatResetTime(resetAt: Date | null): string {
  if (!resetAt) return '';
  const now = new Date();
  const diffMs = resetAt.getTime() - now.getTime();
  if (diffMs <= 0) return '';

  const diffMins = Math.ceil(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
