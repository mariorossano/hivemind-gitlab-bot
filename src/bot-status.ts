import { z } from 'zod/v3';
import type { GitLabBot } from './runtime.ts';

const sections = {
  subscriptions: { table: 'subscriptions', columns: 'id,url,channel,enabled,source_kind,event_filter,last_poll,last_queued,last_error,failures,next_at', order: 'id', where: '' },
  lifecycle: { table: 'source_lifecycle', columns: '*', order: 'subscription', where: '' },
  deliveryErrors: { table: 'events', columns: 'id,subscription,state,error,attempts,next_at,pause_generation', order: 'id', where: ' WHERE error IS NOT NULL' },
  watchJobs: { table: 'watch_jobs', columns: 'url,state,error', order: 'url', where: '' },
  watchRoutes: { table: 'mr_routes', columns: 'url,name,channel,subscription,origin', order: 'url', where: '' },
  watch: { table: 'repository_watch', columns: 'id,spec,subscription,project,account,hive_project,brain,initialized,enabled,next_at,last_error', order: 'id', where: '' },
} as const;
const statusInput = z.object({
  section: z.enum(['summary', 'subscriptions', 'lifecycle', 'deliveryErrors', 'watchJobs', 'watchRoutes', 'watch']).default('summary'),
  offset: z.number().int().min(0).max(1_000_000_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

/** The callable status is paged; the operator CLI retains its detailed local dump.
 * Free-form diagnostics are previews, explicitly marked when shortened. Never query credentials.
 */
export function botStatus(bot: GitLabBot, raw: unknown) {
  const input = statusInput.parse(raw);
  const monitorRunning = bot.isRunning();
  const count = (key: keyof typeof sections) => {
    const section = sections[key];
    return Number(bot.db.prepare(`SELECT COUNT(*) AS n FROM ${section.table}${section.where}`).get()!.n);
  };
  if (input.section === 'summary') return {
    monitorRunning, desiredRunning: bot.desired(),
    sections: Object.fromEntries(Object.keys(sections).map(key => [key, count(key as keyof typeof sections)])),
    hint: 'Use status with section, offset and limit for details. Text previews may be shortened; private operator status retains full diagnostics.',
  };
  const section = sections[input.section], total = count(input.section);
  const rawRows = bot.db.prepare(`SELECT ${section.columns} FROM ${section.table}${section.where} ORDER BY ${section.order} LIMIT ? OFFSET ?`)
    .all(input.limit, input.offset);
  const rows: Record<string, unknown>[] = [], truncatedFields: { offset: number; fields: string[] }[] = [];
  let bytes = 0;
  for (const rawRow of rawRows) {
    const fields: string[] = [];
    const row = Object.fromEntries(Object.entries(rawRow).map(([key, value]) => {
      if (typeof value === 'string' && value.length > 512) { fields.push(key); return [key, value.slice(0, 512) + '…']; }
      return [key, value];
    }));
    const size = Buffer.byteLength(JSON.stringify(row)) + Buffer.byteLength(JSON.stringify(fields)) + 64;
    if (rows.length && bytes + size > 48 * 1024) break;
    bytes += size;
    if (fields.length) truncatedFields.push({ offset: input.offset + rows.length, fields });
    rows.push(row);
  }
  return { monitorRunning, section: input.section, total, offset: input.offset, rows, truncatedFields,
    nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null };
}
