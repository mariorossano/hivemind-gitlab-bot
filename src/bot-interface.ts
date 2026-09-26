import { z } from 'zod/v3';
import { GitLabBot } from './runtime.ts';
import { assertProject, projectBinding } from './profile.ts';
import { botStatus } from './bot-status.ts';

const inputSchema = z.object({
  tool: z.enum(['connect', 'status', 'start', 'stop', 'follow', 'unfollow', 'watch', 'stop_watch', 'resume_watch']),
  projectId: z.string().min(1), botId: z.string().min(1), botName: z.string().min(1),
  arguments: z.record(z.unknown()), token: z.string().min(1).optional(),
}).strict();

/** The canonical Hivemind bot entry point. No model, arbitrary command, provider writes or chat intake. */
export async function invoke(home: string, raw: unknown) {
  const input = inputSchema.parse(raw);
  const bot = new GitLabBot(home);
  try {
    if (!projectBinding(home)) throw new Error('Configure the project binding first');
    assertProject(home, input.projectId, bot.config.hiveUrl);
    if (input.tool === 'connect') {
      z.object({}).strict().parse(input.arguments);
      if (!input.token) throw new Error('A bot token is required');
      const release = bot.lock('setup');
      let hold = () => {};
      try {
        hold = bot.lock();
        const current = bot.db.prepare('SELECT id FROM bots WHERE project=?').get(input.projectId);
        if (current && current.id !== input.botId) throw new Error('Profile already belongs to another bot');
        if (bot.db.prepare('SELECT 1 FROM bots WHERE project<>?').get(input.projectId)) throw new Error('Profile belongs to another project');
        bot.db.prepare('INSERT INTO bots(project,id,name,token) VALUES(?,?,?,?) ON CONFLICT(project) DO UPDATE SET name=excluded.name,token=excluded.token')
          .run(input.projectId, input.botId, input.botName, input.token);
        return { connected: true };
      } finally { hold(); release(); }
    }
    if (input.token !== undefined) throw new Error('Credentials are only accepted by connect');
    const current = bot.db.prepare('SELECT id FROM bots WHERE project=?').get(input.projectId);
    if (!current || current.id !== input.botId) throw new Error('Connect this bot identity first');
    if (input.tool === 'status') return botStatus(bot, input.arguments);
    if (['start', 'stop'].includes(input.tool)) z.object({}).strict().parse(input.arguments);
    if (input.tool === 'start') { await bot.start(); return { monitorRunning: true }; }
    if (input.tool === 'stop') {
      bot.desired(false);
      // A running daemon reports on exit. If it is already offline, no daemon
      // remains to reconcile the source-link status shown in Hivemind.
      if (!bot.isRunning()) await bot.reportStopped();
      return { stopRequested: true, monitorRunning: bot.isRunning() };
    }
    if (input.tool === 'watch') {
      const args = z.object({ repository: z.string().url(), channel: z.string().min(1), brain: z.string().min(1),
        label: z.string().min(1).optional(), authors: z.array(z.string().min(1)).default(['all']), excludeAuthors: z.array(z.string().min(1)).default([]),
        initial: z.enum(['summary', 'follow']).default('summary') }).strict().parse(input.arguments);
      const release = bot.lock('setup');
      let hold = () => {};
      let configured;
      try { hold = bot.lock(); configured = await bot.watch.configure(args); }
      finally { hold(); release(); }
      // The exclusive setup hold is not a daemon. Inspect liveness only after
      // releasing it so the receipt cannot claim monitoring started implicitly.
      return { ...configured, monitorRunning: bot.isRunning() };
    }
    if (input.tool === 'stop_watch' || input.tool === 'resume_watch') {
      const args = z.object({ id: z.string().min(1) }).strict().parse(input.arguments);
      const release = bot.lock('setup');
      try { return await bot.watch.setEnabled(args.id, input.tool === 'resume_watch'); } finally { release(); }
    }
    if (input.tool === 'follow') {
      const args = z.object({ url: z.string().url(), channel: z.string().min(1), initial: z.enum(['snapshot', 'baseline']).default('snapshot') }).strict().parse(input.arguments);
      // Configure only. Starting/polling is an explicit separate action.
      const release = bot.lock('setup');
      let hold = () => {};
      try { hold = bot.lock(); return await bot.follow(args.url, args.channel, args.initial); }
      finally { hold(); release(); }
    }
    const args = z.object({ id: z.string().min(1) }).strict().parse(input.arguments);
    const result = bot.unfollow(args.id);
    if (!bot.isRunning()) await bot.reportStopped(args.id);
    return result;
  } finally { bot.close(); }
}
