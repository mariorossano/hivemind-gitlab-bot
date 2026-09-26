/** Native loopback client for the bot's existing, Human-authorized UI operations.
 * Uses the supported session endpoint, not browser cookies or agent credentials.
 * Human capabilities remain private, in memory, and never reach the bot protocol.
 */
export function hiveOrigin(input: string) {
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/?$/.test(input))
    throw new Error('Use an explicit numeric-loopback Hivemind HTTP origin');
  try { return new URL(input).origin; }
  catch { throw new Error('Use an explicit numeric-loopback Hivemind HTTP origin'); }
}

function isUIRoute(route: string, method: string) {
  if (route === '/api/ui/snapshot' && method === 'GET') return true;
  if (/^\/api\/ui\/channels\/[^/]+\/room$/.test(route) && ['GET', 'POST'].includes(method)) return true;
  return method === 'POST' && (route === '/api/ui/channels' ||
    /^\/api\/ui\/(?:projects\/[^/]+\/bots|channels\/[^/]+\/invite)$/.test(route));
}

export class LocalHiveSession {
  readonly #origin: string;
  #cookie?: string;
  #generation = 0;
  #pending?: Promise<void>;
  constructor(origin: string) { this.#origin = hiveOrigin(origin); }

  async #establish() {
    const response = await fetch(this.#origin + '/api/ui/session', {
      method: 'POST', headers: { Origin: this.#origin, 'Content-Type': 'application/json' }, body: '{}',
      redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000),
    });
    try {
      if (!response.ok) throw new Error(`Hivemind session bootstrap failed (HTTP ${response.status})`);
      const name = `hivemind_human_${new URL(this.#origin).port || '80'}`;
      const cookies = response.headers.getSetCookie().filter(c => c.startsWith(name + '='));
      const pair = cookies.length === 1 ? cookies[0]!.split(';')[0]! : '';
      if (!new RegExp('^' + name + '=[A-Za-z0-9_-]{43}$').test(pair))
        throw new Error('Hivemind returned an invalid local session');
      this.#cookie = pair;
      this.#generation++;
    } finally { await response.body?.cancel(); }
  }

  async request(route: string, options: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    options = { ...options }; // Freeze the replayable body/options against caller mutation.
    // Do not allow normalization, an absolute URL, redirects or a caller-controlled
    // credential to move the Human capability outside these exact local operations.
    if (!route.startsWith('/api/') || /[?#\\]/.test(route)) throw new Error('Unsupported Hivemind route');
    const target = new URL(route, this.#origin);
    if (target.origin !== this.#origin || target.pathname !== route || route.split('/').some(part => {
      try { const value = decodeURIComponent(part); return value === '.' || value === '..' || /[/\\?#]/.test(value); }
      catch { return true; }
    })) throw new Error('Unsupported Hivemind route');
    const method = (options.method ?? 'GET').toUpperCase();
    const ui = isUIRoute(route, method);
    const bot = /^\/api\/bot\/channels\/[^/]+\/(?:messages|links(?:\/[^/]+\/status)?)$/.test(route) && ['GET', 'POST'].includes(method);
    if (!ui && !bot) throw new Error('Unsupported Hivemind operation');
    if (ui && options.body != null && typeof options.body !== 'string') throw new Error('Expected a replayable JSON body');
    const headers = new Headers(options.headers);
    if (['cookie', 'x-hivemind-human', 'origin', 'x-hivemind-ui', 'host'].some(k => headers.has(k)) ||
        (ui && headers.has('authorization'))) throw new Error('Caller-supplied Human credentials are not supported');
    const signals = [signal, options.signal].filter((s): s is AbortSignal => s != null);
    const external = signals.length ? AbortSignal.any(signals) : undefined;
    external?.throwIfAborted();
    const send = () => {
      external?.throwIfAborted();
      const current = new Headers(headers);
      if (ui) {
        current.set('Origin', this.#origin);
        current.set('X-Hivemind-UI', '1');
        if (this.#cookie) current.set('Cookie', this.#cookie);
      }
      return fetch(target, { ...options, method, headers: current, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...signals]) });
    };
    const usedGeneration = this.#generation;
    const response = await send();
    // Only the core's pre-handler marker proves that even a POST had no effects.
    // Generic 401, 403, timeout, network errors and bot denials are never retried.
    if (!ui || response.status !== 401 || response.headers.get('x-hivemind-session-required') !== '1') return response;
    await response.body?.cancel();
    external?.throwIfAborted();
    if (this.#generation === usedGeneration) {
      this.#pending ??= this.#establish().finally(() => { this.#pending = undefined; });
      const pending = this.#pending;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(external!.reason);
        external?.addEventListener('abort', onAbort, { once: true });
        pending.then(resolve, reject).finally(() => external?.removeEventListener('abort', onAbort));
        if (external?.aborted) onAbort();
      });
    }
    return send(); // Exactly one session-refresh replay; a second 401 is final.
  }
}
