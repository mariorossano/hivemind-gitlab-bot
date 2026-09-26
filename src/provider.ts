import { z } from 'zod/v3';
import { readGitLab } from './readers/gitlab.ts';
import type { Runner } from './readers/process.ts';
export const definitionId = 'hivemind-gitlab';
export const usageNotice = 'Polling uses glab GET requests only; no Claude tokens are consumed.';
export const label = 'GitLab';
export const configSchema = z.object({
  hiveUrl: z.string().url(), host: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]+)?$/),
  executable: z.string().min(1).default('glab'), intervalSeconds: z.number().int().min(60).max(86400).default(300),
  timeoutSeconds: z.number().int().min(5).max(600).default(90), maxPages: z.number().int().min(1).max(20).default(5),
}).strict();
export type Config = z.infer<typeof configSchema>;
export const profileIdentity = (config:Config) => [definitionId,config.hiveUrl,config.host];
export function parseSource(input: string, config: Config) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.host !== config.host || url.username || url.password) throw new Error('Use an HTTPS MR URL on the configured GitLab host');
  const match = /^\/(.+)\/-\/merge_requests\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (!match || !match[1]!.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part))) throw new Error('Use an exact GitLab MR URL');
  const mr = Number(match[2]);
  if (!Number.isSafeInteger(mr)) throw new Error('Invalid MR number');
  return { ...config, projectPath: match[1]!, hostname: config.host, mr, url: `${url.origin}/${match[1]}/-/merge_requests/${mr}` };
}
export async function read(input: string, config: Config, directory: string, runner: Runner, signal?: AbortSignal, events?:string[]) {
  return readGitLab(parseSource(input, config), directory, runner, signal,events);
}
