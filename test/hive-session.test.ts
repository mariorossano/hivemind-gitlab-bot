import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalHiveSession, hiveOrigin } from '../src/hive-session.ts';

async function fixture(t: TestContext) {
  const calls: {route:string; method:string; cookie?:string; origin?:string; human?:string; authorization?:string; body:string}[]=[];
  const hooks={ bootstrapDelay:0, bootstrapStatus:200, invalidCookie:false, legacy:false,
    before:undefined as ((req:IncomingMessage,res:ServerResponse)=>boolean)|undefined,
    after:undefined as ((req:IncomingMessage,res:ServerResponse)=>boolean)|undefined };
  let secret='a'.repeat(43),bootstraps=0,effects=0,base='',port=0;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    calls.push({route:req.url!,method:req.method!,cookie:req.headers.cookie,origin:req.headers.origin,
      human:req.headers['x-hivemind-human'] as string|undefined,authorization:req.headers.authorization,body});
    res.setHeader('Content-Type','application/json');
    const reply=(status:number,value:unknown)=>{res.writeHead(status);res.end(JSON.stringify(value));};
    if(hooks.before?.(req,res))return;
    if(req.url==='/api/ui/session') {
      bootstraps++;
      assert.equal(req.method,'POST');assert.equal(req.headers.origin,base);assert.equal(body,'{}');
      assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.authorization,undefined);
      assert.equal(req.headers['content-type'],'application/json');
      await delay(hooks.bootstrapDelay);
      if(hooks.bootstrapStatus!==200){reply(hooks.bootstrapStatus,{error:'not allowed'});return;}
      res.setHeader('Set-Cookie',hooks.invalidCookie?'hivemind_human_1=invalid':`hivemind_human_${port}=${secret}; HttpOnly; SameSite=Strict; Path=/`);
      reply(200,{ok:true});return;
    }
    if(req.url?.startsWith('/api/ui/')&&!hooks.legacy&&req.headers.cookie!==`hivemind_human_${port}=${secret}`) {
      res.setHeader('X-Hivemind-Session-Required','1');reply(401,{error:'Human session required'});return;
    }
    if(req.url?.startsWith('/api/ui/'))assert.equal(req.headers.origin,base);
    if(hooks.after?.(req,res))return;
    if(req.method==='POST')effects++;
    reply(200,{ok:true});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  port=(server.address() as any).port;base='http://127.0.0.1:'+port;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {base,calls,hooks,client:new LocalHiveSession(base),rotate:()=>{secret='b'.repeat(43);},
    get bootstraps(){return bootstraps;},get effects(){return effects;}};
}
const create={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'fixture'})};
async function consume(promise:Promise<Response>) {const r=await promise;await r.body?.cancel();return r.status;}

test('session bootstrap is private and one rejected POST produces exactly one effect',async t=>{
  const f=await fixture(t);
  assert.equal(await consume(f.client.request('/api/ui/channels',create)),200);
  assert.equal(f.bootstraps,1);assert.equal(f.effects,1);
  assert.deepEqual(f.calls.map(c=>c.route),['/api/ui/channels','/api/ui/session','/api/ui/channels']);
  assert.equal(f.calls[0]!.body,f.calls[2]!.body);
  assert.ok(!JSON.stringify(f.client).includes('a'.repeat(43)));
});
test('parallel requests share one bootstrap and a core restart refreshes once',async t=>{
  const f=await fixture(t);f.hooks.bootstrapDelay=30;
  assert.deepEqual(await Promise.all([consume(f.client.request('/api/ui/snapshot')),consume(f.client.request('/api/ui/channels',create))]),[200,200]);
  assert.equal(f.bootstraps,1);assert.equal(f.effects,1);
  f.rotate();assert.equal(await consume(f.client.request('/api/ui/channels',create)),200);
  assert.equal(f.bootstraps,2);assert.equal(f.effects,2);
});
test('refresh preserves the original POST payload even if caller options change while awaiting auth',async t=>{
  const f=await fixture(t),options={...create};f.hooks.bootstrapDelay=25;
  const pending=consume(f.client.request('/api/ui/channels',options));
  options.body=JSON.stringify({name:'unexpected-change'});options.method='DELETE';
  assert.equal(await pending,200);assert.equal(f.effects,1);
  assert.deepEqual(f.calls.filter(c=>c.route==='/api/ui/channels').map(c=>[c.method,c.body]),[['POST',create.body],['POST',create.body]]);
});
test('bot calls never receive or refresh a Human capability, even on a marked 401',async t=>{
  const f=await fixture(t);await consume(f.client.request('/api/ui/snapshot'));
  f.hooks.before=(req,res)=>{if(!req.url?.startsWith('/api/bot/'))return false;
    res.writeHead(401,{'X-Hivemind-Session-Required':'1'});res.end('{}');return true;};
  assert.equal(await consume(f.client.request('/api/bot/channels/fixture/links',{headers:{Authorization:'Bearer fake-bot-only'}})),401);
  const call=f.calls.at(-1)!;assert.equal(call.authorization,'Bearer fake-bot-only');
  assert.equal(call.cookie,undefined);assert.equal(call.human,undefined);assert.equal(call.origin,undefined);
  assert.equal(f.bootstraps,1);
});
for(const status of [401,403,409,429,500])test(`UI handler HTTP ${status} is not retried or treated as a new session`,async t=>{
  const f=await fixture(t);await consume(f.client.request('/api/ui/snapshot'));
  f.hooks.after=(_req,res)=>{res.writeHead(status);res.end('{}');return true;};
  const before=f.calls.length;assert.equal(await consume(f.client.request('/api/ui/channels',create)),status);
  assert.equal(f.calls.length,before+1);assert.equal(f.bootstraps,1);
});
test('a generic first-request 401 does not trigger bootstrap',async t=>{
  const f=await fixture(t);f.hooks.before=(_req,res)=>{res.writeHead(401);res.end('{}');return true;};
  assert.equal(await consume(f.client.request('/api/ui/snapshot')),401);assert.equal(f.bootstraps,0);assert.equal(f.calls.length,1);
});
test('second marked 401 is final; no infinite refresh or mutation loop',async t=>{
  const f=await fixture(t);f.hooks.after=(_req,res)=>{res.writeHead(401,{'X-Hivemind-Session-Required':'1'});res.end('{}');return true;};
  assert.equal(await consume(f.client.request('/api/ui/channels',create)),401);
  assert.equal(f.bootstraps,1);assert.equal(f.calls.length,3);assert.equal(f.effects,0);
});
test('missing or wrong-port session cookies fail closed',async t=>{
  const f=await fixture(t);f.hooks.invalidCookie=true;
  await assert.rejects(f.client.request('/api/ui/channels',create),/invalid local session/);
  assert.equal(f.effects,0);assert.equal(f.calls.length,2);
});
test('denied bootstrap is not retried and does not leak response text',async t=>{
  const f=await fixture(t);f.hooks.bootstrapStatus=403;
  await assert.rejects(f.client.request('/api/ui/snapshot'),/^Error: Hivemind session bootstrap failed \(HTTP 403\)$/);
  assert.equal(f.bootstraps,1);assert.equal(f.calls.length,2);
});
test('lost mutation response is not replayed',async t=>{
  const f=await fixture(t);await consume(f.client.request('/api/ui/snapshot'));let accepted=0;
  f.hooks.after=(req)=>{accepted++;req.socket.destroy();return true;};
  await assert.rejects(f.client.request('/api/ui/channels',create));assert.equal(accepted,1);assert.equal(f.bootstraps,1);
});
test('redirects never carry the session to another origin',async t=>{
  const f=await fixture(t),other=await fixture(t);await consume(f.client.request('/api/ui/snapshot'));
  f.hooks.after=(_req,res)=>{res.writeHead(302,{Location:other.base+'/api/ui/snapshot'});res.end();return true;};
  await assert.rejects(f.client.request('/api/ui/snapshot'));assert.equal(other.calls.length,0);
});
test('unsafe origins, routes, unsupported actions and caller credentials are rejected before network access',async t=>{
  for(const origin of ['https://127.0.0.1:80','http://localhost:80','http://127.1:80','http://2130706433',
    'http://evil.invalid','http://user:secret@127.0.0.1','http://127.0.0.1:0','http://127.0.0.1:99999','http://127.0.0.1/path'])
    assert.throws(()=>hiveOrigin(origin));
  assert.equal(hiveOrigin('http://[::1]:61170/'),'http://[::1]:61170');
  const f=await fixture(t);
  for(const route of ['http://evil.invalid/api/ui/snapshot','//evil.invalid/api/ui/snapshot','/api/ui/session',
    '/api/ui/channels/a/%2e%2e/room','/api/ui/channels/../snapshot','/api/ui/snapshot?extra=1',
    '/api/ui/channels/%2froom/room','/api/ui/snapshot#x','/api/ui/settings','/api/agent/join'])
    await assert.rejects(f.client.request(route));
  await assert.rejects(f.client.request('/api/ui/snapshot',{method:'DELETE'}));
  for(const header of ['Cookie','X-Hivemind-Human','Authorization','Origin','X-Hivemind-UI','Host'])
    await assert.rejects(f.client.request('/api/ui/snapshot',{headers:{[header]:'foreign'}}));
  await assert.rejects(f.client.request('/api/ui/channels',{...create,body:new URLSearchParams()}));
  assert.equal(f.calls.length,0);
});
test('cancelled request is not sent; cancellation during bootstrap never replays POST',async t=>{
  const f=await fixture(t),already=new AbortController();already.abort();
  await assert.rejects(f.client.request('/api/ui/snapshot',{},already.signal));assert.equal(f.calls.length,0);
  f.hooks.bootstrapDelay=80;const abort=new AbortController();
  const pending=f.client.request('/api/ui/channels',create,abort.signal);
  const rejected=assert.rejects(pending);
  while(!f.bootstraps)await delay(5);abort.abort();await rejected;
  await delay(100);assert.equal(f.effects,0);assert.equal(f.calls.length,2);
});
test('session state is not shared across bot clients or origins; legacy cores need no bootstrap',async t=>{
  const f=await fixture(t),other=await fixture(t);await consume(f.client.request('/api/ui/snapshot'));
  await consume(other.client.request('/api/ui/snapshot'));assert.equal(other.calls[0]!.cookie,undefined);
  await consume(new LocalHiveSession(f.base).request('/api/ui/snapshot'));assert.equal(f.bootstraps,2);
  const legacy=await fixture(t);legacy.hooks.legacy=true;
  assert.equal(await consume(legacy.client.request('/api/ui/snapshot')),200);assert.equal(legacy.bootstraps,0);
});
