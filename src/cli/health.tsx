import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig } from 'agent-bundle';
import { z } from 'zod';

import { checkGatewayHealth } from '../core/gateway.js';

export const config = {
  description: 'Make one live read call to the Grok Bot gateway; exit 1 with the reason when it fails.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {},
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({}).strict();
export const resultSchema = z.object({
  bots: z.number().int().optional(),
  daysLeft: z.number().int().optional(),
  error: z.string().optional(),
  exitCode: z.union([z.literal(0), z.literal(1)]),
  groups: z.number().int().optional(),
  hint: z.string().optional(),
  latencyMs: z.number(),
  method: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  source: z.string(),
  status: z.number().int().optional(),
  tokenSource: z.enum(['env', 'op', 'cursor']).optional(),
  tokenWarning: z.string().optional(),
}).strict();

const TOKEN_SOURCE_LABELS: Record<string, string> = {
  env: 'CURSOR_ACCESS_TOKEN',
  op: '1Password',
  cursor: 'the Cursor app',
};

export default async function health() {
  const result = await checkGatewayHealth();
  const value = resultSchema.parse({ ...result, exitCode: result.ok ? 0 : 1 });
  const tokenLine = value.tokenSource
    ? `Cursor token from ${TOKEN_SOURCE_LABELS[value.tokenSource]}${value.daysLeft === undefined ? '' : `, ${value.daysLeft} days left`}`
    : undefined;
  const text = value.ok
    ? [
        `gateway ok: ${value.method} answered in ${value.latencyMs} ms (${value.bots} bots, ${value.groups} groups) via ${value.source}`,
        tokenLine,
        value.tokenWarning,
      ].filter(Boolean).join('\n')
    : [`gateway failed: ${value.reason}`, value.error, tokenLine, value.tokenWarning, value.hint].filter(Boolean).join('\n');
  return (
    <Agent.Result value={value}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
