import type { Config } from '../provider.ts';
export type GitLabSource = Config & { hostname: string; projectPath: string; mr: number; url: string };
export type Observation = { key: string; value: unknown; body: string; author?: string; url: string; occurredAt?: number };
export type Snapshot = { observations: Observation[]; usage?: unknown; warnings?: string[] };
export function excerpt(text: string, limit = 3300) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[Excerpt truncated; open the original for the full text.]`;
}
