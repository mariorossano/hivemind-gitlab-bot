import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod/v3';

export type Source = { id: string; channel: string; bot: string; enabled: number };
type Request = (route: string, options?: RequestInit, signal?: AbortSignal) => Promise<any>;
const linkSchema = z.object({
  id: z.string(), botId: z.string(), label: z.string(), suspendSupported: z.boolean(),
  desired: z.enum(['running', 'paused']), generation: z.number().int().positive().safe(),
  observed: z.enum(['pending', 'running', 'paused', 'failed', 'unsupported']), detail: z.string(),
});
export class LifecycleDeferred extends Error {}
export const archiveError = 'Channel is archived; suspend this source link. Do not discard undelivered source events.';
export class HiveHttpError extends Error {
  constructor(readonly status: number, readonly archived = false) { super('Hivemind HTTP ' + status); }
}

/** Generic source-link protocol; no provider reads or monitor starts happen here. */
export class SourceLifecycle {
  constructor(readonly db: DatabaseSync, readonly request: Request, readonly label: string) {}
  state(id: string) { return this.db.prepare('SELECT * FROM source_lifecycle WHERE subscription=?').get(id); }
  headers(sub: Source) {
    const bot = this.db.prepare('SELECT token FROM bots WHERE id=?').get(sub.bot);
    if (!bot || typeof bot.token !== 'string') throw new Error('Source bot credential unavailable');
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bot.token };
  }
  route(sub: Source) { return '/api/bot/channels/' + encodeURIComponent(sub.channel) + '/links'; }
  async sync(sub: Source, signal?: AbortSignal, report = true, stopped = false) {
    this.db.prepare('INSERT OR IGNORE INTO source_lifecycle(subscription) VALUES (?)').run(sub.id);
    try {
      const headers = this.headers(sub), route = this.route(sub);
      const response = await this.request(route, { headers }, signal);
      const links = z.array(linkSchema).parse(response.links);
      let link = links.find(l => l.id === sub.id);
      if (!link) {
        const created = await this.request(route, { method: 'POST', headers,
          body: JSON.stringify({ id: sub.id, label: this.label + ' source ' + sub.id, suspendSupported: true }) }, signal);
        link = linkSchema.parse(created.link);
      }
      if (link.id !== sub.id || link.botId !== sub.bot || !link.suspendSupported ||
          link.label !== this.label + ' source ' + sub.id) throw new Error('Source lifecycle identity mismatch');
      const previous = this.state(sub.id)!;
      if (link.generation < Number(previous.generation)) throw new Error('Source lifecycle generation regressed; reconcile server/profile backups');
      if (link.generation === previous.generation && previous.desired !== 'unknown' && previous.desired !== link.desired)
        throw new Error('Source lifecycle changed without a new generation');
      this.db.prepare("UPDATE source_lifecycle SET generation=?,desired=?,applied='pending',checked_at=?,error=NULL WHERE subscription=?")
        .run(link.generation, link.desired, Date.now(), sub.id);
      // Re-read local intent after each awaited request: unfollow/stop must win.
      const enabled = this.db.prepare('SELECT enabled FROM subscriptions WHERE id=?').get(sub.id)?.enabled === 1;
      const applied = link.desired === 'paused' ? 'paused' : !enabled ? 'disabled' : stopped ? 'stopped' : 'running';
      const observed = applied === 'disabled' || applied === 'stopped' ? 'failed' : applied;
      const detail = applied === 'disabled' ? 'Subscription explicitly unfollowed; channel resume does not enable it.' :
        applied === 'stopped' ? 'Monitor explicitly stopped; channel resume does not start it.' : '';
      if (report && (link.observed !== observed || link.detail !== detail)) {
        const receipt = linkSchema.parse((await this.request(route + '/' + encodeURIComponent(sub.id) + '/status', {
          method: 'POST', headers, body: JSON.stringify({ generation: link.generation, observed, detail }),
        }, signal)).link);
        if (receipt.id !== sub.id || receipt.botId !== sub.bot || receipt.generation !== link.generation ||
            receipt.desired !== link.desired || receipt.observed !== observed || receipt.detail !== detail)
          throw new Error('Invalid source lifecycle receipt');
      }
      signal?.throwIfAborted();
      const stillEnabled = this.db.prepare('SELECT enabled FROM subscriptions WHERE id=?').get(sub.id)?.enabled === 1;
      if (applied === 'running' && !stillEnabled) {
        this.db.prepare("UPDATE source_lifecycle SET applied='disabled' WHERE subscription=?").run(sub.id);
        return { running: false, generation: link.generation, desired: link.desired };
      }
      this.db.prepare('UPDATE source_lifecycle SET applied=? WHERE subscription=?').run(report ? applied : 'pending', sub.id);
      if (link.desired === 'running' && previous.desired === 'paused')
        this.db.prepare('UPDATE subscriptions SET next_at=0 WHERE id=?').run(sub.id);
      if (report && applied === 'running') {
        // Only proven archive holds are resumed automatically; generic blocked errors stay blocked.
        this.db.prepare(`UPDATE events SET state='pending',next_at=0,error=NULL WHERE subscription=?
          AND state='paused' AND pause_generation IS NOT NULL AND pause_generation<?`).run(sub.id, link.generation);
      }
      return { running: report && applied === 'running', generation: link.generation, desired: link.desired };
    } catch (error) {
      this.db.prepare("UPDATE source_lifecycle SET applied='failed',checked_at=?,error=? WHERE subscription=?")
        .run(Date.now(), error instanceof HiveHttpError ? error.message : 'Source lifecycle check failed; no read or delivery performed', sub.id);
      throw error;
    }
  }
}
