import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitLabBot, init } from '../src/runtime.ts';
import { WatchReader, watchSchema, repositoryPath, eventTypes } from '../src/watch-reader.ts';
import { HiveHttpError } from '../src/lifecycle.ts';
import { createHash } from 'node:crypto';
import { mrChannelName } from '../src/mr-context.ts';

const repository='https://gitlab.example.invalid/group/repo';
const stamp=(delta=0)=>new Date(Date.now()+delta).toISOString();
function mr(iid:number, labels:string[]=['ready for review'], authorId=8) {
  return {id:1000+iid,iid,project_id:42,title:'Fixture '+iid,web_url:`${repository}/-/merge_requests/${iid}`,
    state:'opened',labels,author:{id:authorId,username:authorId===7?'operator':'reviewer',name:'Invented'},
    created_at:stamp(-60000),updated_at:stamp(),source_branch:'feature-'+iid,target_branch:'main',sha:'a'.repeat(40),draft:false,
    detailed_merge_status:'mergeable',has_conflicts:false,head_pipeline:{id:1,status:'success',sha:'a'.repeat(40),web_url:repository+'/-/pipelines/1'}};
}
function note(id:number,body='Invented comment',delta=-60000) {
  return {id,body,author:{id:8,name:'Invented'},system:false,created_at:stamp(delta),updated_at:stamp(delta),resolvable:true,resolved:false};
}
function fixture(t:TestContext,simpleContracts=false) {
  const home=mkdtempSync(path.join(os.tmpdir(),'gitlab-watch-test-'));
  init(home,{hiveUrl:'http://127.0.0.1:19731',host:'gitlab.example.invalid'});
  const mrs:any[]=[], notes=new Map<number,any[]>(), labels=new Map<number,any[]>();
  const agents:any[]=[{id:'brain',name:'Brain',role:'brain',projectId:'p'}];
  const channels:any[]=[{id:'summary',name:'summary',type:'private',projectId:'p',memberIds:['human','brain'],topic:'Existing summary'}];
  const rooms=new Map<string,any>(), links=new Map<string,any>(), messages=new Map<string,any>();
  const providerCalls:string[]=[], hiveCalls:string[]=[];
  const hooks={account:7,project:42,loseCreate:false,denyCreate:0,failSnapshot:false,beforeGet:undefined as ((endpoint:string)=>void)|undefined};
  let approvals:any[]=[];
  const runner=async(command:any)=>{
    assert.equal(command.args[0],'api');assert.equal(command.args[command.args.indexOf('--method')+1],'GET');
    assert.equal(command.args[command.args.indexOf('--hostname')+1],'gitlab.example.invalid');
    const endpoint:string=command.args[1];providerCalls.push(endpoint);hooks.beforeGet?.(endpoint);
    const u=new URL('https://gitlab.example.invalid/'+endpoint), p=decodeURIComponent(u.pathname);
    let result:any;
    if(p==='/user')result={id:hooks.account,username:'operator'};
    else if(p==='/projects/group/repo')result={id:hooks.project,path_with_namespace:'group/repo',web_url:repository};
    else if(p==='/projects/42/merge_requests') {
      result=mrs.filter(m=>(u.searchParams.get('state')!=='opened'||m.state==='opened')&&(!u.searchParams.has('updated_after')||m.updated_at>=u.searchParams.get('updated_after')!));
      const page=Number(u.searchParams.get('page'));result=result.slice((page-1)*100,page*100);
    } else {
      const match=/\/merge_requests\/(\d+)(.*)/.exec(p);assert.ok(match,'Unexpected fixture endpoint '+p);
      const iid=Number(match[1]), found=mrs.find(m=>m.iid===iid);assert.ok(found,'Unknown fixture MR');
      if(match[2]==='/discussions')result=(notes.get(iid)??[]).map(n=>({id:'discussion-'+n.id,individual_note:false,notes:[n]}));
      else if(match[2]==='/resource_label_events')result=labels.get(iid)??[];
      else if(match[2]==='/approvals')result={iid,project_id:42,approved:approvals.length>0,approved_by:approvals};
      else {assert.equal(match[2],'');result=found;}
    }
    return {stdout:JSON.stringify(result)};
  };
  const request=async(route:string,options:RequestInit={})=>{
    hiveCalls.push((options.method??'GET')+' '+route);
    const body=options.body?JSON.parse(String(options.body)):{};
    if(route==='/api/ui/snapshot') {if(hooks.failSnapshot)throw new Error('fixture snapshot offline');return structuredClone({channels,agents,projects:[{id:'p',slug:'fixture'}]});}
    if(route==='/api/ui/projects/p/bots') {
      const bot={id:'bot'+agents.length,name:body.name,role:'bot',projectId:'p'};agents.push(bot);return {bot,token:'synthetic-only-'+bot.id};
    }
    if(route==='/api/ui/channels') {
      assert.equal(body.project,'fixture','channel creation uses the verified slug, never the stored UUID');
      if(hooks.denyCreate)throw new HiveHttpError(hooks.denyCreate);
      if(channels.some(c=>c.name===body.name&&c.projectId==='p'))throw new HiveHttpError(409);
      const channel={id:'channel-'+channels.length,name:body.name,type:body.type,topic:body.topic,projectId:'p',
        memberIds:['human',...body.memberNames.map((name:string)=>agents.find(a=>a.name===name)!.id)]};channels.push(channel);
      if(hooks.loseCreate){hooks.loseCreate=false;throw new Error('lost response');}return {channel};
    }
    const match=/\/channels\/([^/]+)\/(.+)/.exec(route);assert.ok(match,'Unexpected fixture route '+route);
    const channel=channels.find(c=>c.id===match[1]);assert.ok(channel);
    if(match[2]==='invite'){for(const name of body.names)channel.memberIds.push(agents.find(a=>a.name===name)!.id);return {channel};}
    if(match[2]==='room') {
      if(options.method==='POST'){
        assert.equal(body.action.type,'configure');assert.equal(body.expectedRevision,0);
        if(simpleContracts)assert.deepEqual(Object.keys(body.action.contract).sort(),['coordinator','instructions','participants']);
        else assert.equal(body.action.contract.mode,'ongoing');
        rooms.set(channel.id,{revision:1,state:'active',contract:body.action.contract});
      }
      return {room:rooms.get(channel.id)??null,...(simpleContracts?{archived:false}:{})};
    }
    const headers=new Headers(options.headers),bot=agents.find(a=>'Bearer synthetic-only-'+a.id===headers.get('Authorization'));
    assert.ok(bot && channel.memberIds.includes(bot.id));
    if(match[2]==='links') {
      if(options.method!=='POST')return {links:[...links.entries()].filter(([k])=>k.startsWith(channel.id+':')).map(([,v])=>v)};
      const key=channel.id+':'+body.id;
      if(!links.has(key))links.set(key,{...body,botId:bot.id,generation:1,desired:'running',observed:'pending',detail:''});
      return {link:structuredClone(links.get(key))};
    }
    if(match[2].startsWith('links/')) {
      const link=links.get(channel.id+':'+match[2].split('/')[1]);assert.ok(link);
      if(body.generation!==link.generation)throw new HiveHttpError(409);
      Object.assign(link,body);return {link:structuredClone(link)};
    }
    if(match[2]==='messages') {
      const key=channel.id+':'+body.eventId;
      if(!messages.has(key))messages.set(key,{id:'message-'+messages.size,channelId:channel.id,authorId:bot.id,authorRole:'bot',botEvent:{eventId:body.eventId},body:body.body});
      return {message:messages.get(key)};
    }
    throw new Error('Unexpected fixture route');
  };
  let gitlab:GitLabBot;
  function open(){gitlab=new GitLabBot(home,runner);gitlab.request=request;}
  open();t.after(()=>{gitlab.close();rmSync(home,{recursive:true,force:true});});
  const spec={repository,channel:'summary',brain:'Brain',label:'ready for review'};
  return {home,mrs,notes,labels,agents,channels,rooms,links,messages,providerCalls,hiveCalls,hooks,spec,
    get gitlab(){return gitlab;},reopen(){gitlab.close();open();},approve(){approvals=[{user:{id:8,username:'reviewer',name:'Invented'}}];},
    configure:(overrides:any={})=>gitlab.watch.configure({...spec,...overrides}),
    archive(channel:string,pause:boolean,resume=true){for(const [key,link] of links)if(key.startsWith(channel+':')&&(pause||resume)){link.desired=pause?'paused':'running';link.generation++;link.observed='pending';}},
    label(iid:number,action:'add'|'remove',id:number){const list=labels.get(iid)??[];list.push({id,action,created_at:stamp(5),label:{id:1,name:'ready for review'}});labels.set(iid,list);},
  };
}

test('R02: default initial summary once, new MR gets one private room, no historical comments or automatic assignments',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));await f.configure();await f.gitlab.cycle();
  assert.equal(f.channels.length,1);assert.equal(f.messages.size,1);assert.match([...f.messages.values()][0].body,/Riepilogo iniziale/);
  const w=f.gitlab.watch.current()!;assert.equal(w.account,7);f.reopen();await f.configure();await f.gitlab.cycle();assert.equal(f.messages.size,1);
  f.mrs.push(mr(2));f.notes.set(2,[note(1)]);await f.gitlab.cycle();
  assert.equal(f.channels.length,2);assert.equal(f.channels[1].type,'private');assert.ok(f.channels[1].memberIds.includes('brain'));
  assert.equal(f.agents.filter(a=>a.role==='bot').length,1);
  assert.match(f.rooms.get(f.channels[1].id).contract.rules[0],/do not start/);
  assert.equal([...f.messages.values()].filter(m=>m.body.includes('Invented comment')).length,0);
  assert.ok(!f.hiveCalls.some(c=>/task|agent\//.test(c)));
  const count=f.messages.size;f.reopen();await f.gitlab.cycle();assert.equal(f.channels.length,2);assert.equal(f.messages.size,count);
});
test('0.8: new MR uses a simple contract and preserves Human instructions across restart',async t=>{
  const f=fixture(t,true);await f.configure();await f.gitlab.cycle();
  f.mrs.push(mr(1));await f.gitlab.cycle();
  assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'ready');
  const room=f.rooms.get(f.channels[1].id);
  assert.match(room.contract.instructions,/do not start a review/);
  assert.match(room.contract.instructions,/No automatic source replies/);
  assert.equal(room.contract.coordinator,'Brain');assert.deepEqual(room.contract.participants,[]);
  room.contract.instructions='Human instructions: preserve this custom workflow.';
  f.reopen();await f.gitlab.cycle();
  assert.equal(f.channels.length,2);assert.equal(room.contract.instructions,'Human instructions: preserve this custom workflow.');
  assert.ok(!f.hiveCalls.some(c=>/task|agent\//.test(c)));
});
test('0.8: reuse accepts a migrated simple contract without rewriting it',async t=>{
  const f=fixture(t,true);const source=mr(1);f.mrs.push(source);await f.configure();await f.gitlab.cycle();
  const channel=manualChannel(f);
  f.rooms.get(channel.id).contract={instructions:'Human-selected reviewer. No automatic work.',coordinator:'Brain',participants:[]};
  const linked=await f.gitlab.follow(source.web_url,channel.id);
  const before=structuredClone(f.rooms.get(channel.id));
  source.labels=[];await f.gitlab.watch.cycle();source.labels=['ready for review'];await f.gitlab.watch.cycle();
  const route=f.gitlab.watch.status()!.routes[0] as any;
  assert.equal(route.channel,channel.id);assert.equal(route.subscription,linked.id);assert.equal(route.origin,'existing');
  assert.deepEqual(f.rooms.get(channel.id),before);assert.equal(f.channels.length,2);
});
test('R02: explicit initial follow and take-existing create current channels without replaying history',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));f.notes.set(1,[note(1)]);const w=await f.configure();await f.gitlab.cycle();
  f.gitlab.watch.takeExisting(w.id);await f.gitlab.cycle();assert.equal(f.channels.length,2);
  assert.ok(![...f.messages.values()].some(m=>m.body.includes('Invented comment')));
  f.gitlab.watch.takeExisting(w.id);await f.gitlab.cycle();assert.equal(f.channels.length,2);
});
test('R02: initial follow option does not issue tasks or import old comments',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));await f.configure({initial:'follow'});await f.gitlab.cycle();assert.equal(f.channels.length,2);
  assert.equal(f.gitlab.watch.current()!.initialized,1);
});
test('R02: configurable authors, me means author ID and exclusion wins',async t=>{
  const f=fixture(t);await f.configure({authors:['all'],excludeAuthors:['me'],initial:'follow'});
  f.mrs.push(mr(1,undefined,7),mr(2,undefined,8),{...mr(3,undefined,9),author:{id:9,username:'operator',name:'Same username is not me'}});
  await f.gitlab.cycle();assert.equal(f.channels.length,3);
  assert.ok(!f.channels.some(c=>c.name===mrChannelName(42,1,'Fixture 1')));assert.ok(f.channels.some(c=>c.name===mrChannelName(42,3,'Fixture 3')));
});
test('R02: named author selection excludes others before label history reads',async t=>{
  const f=fixture(t);await f.configure({authors:['reviewer'],initial:'follow'});
  f.mrs.push(mr(1,undefined,7),mr(2));await f.gitlab.cycle();assert.equal(f.channels.length,2);
  assert.ok(f.channels.some(c=>c.name===mrChannelName(42,2,'Fixture 2')));
});
test('R02: label added later, removed/readded and Draft are separate; stable channel survives title changes',async t=>{
  const f=fixture(t);const source=mr(1,[]);f.mrs.push(source);await f.configure();await f.gitlab.cycle();
  source.labels=['ready for review'];source.draft=true;f.label(1,'add',1);await f.gitlab.cycle();assert.equal(f.channels.length,2);
  source.labels=[];f.label(1,'remove',2);await f.gitlab.cycle();source.labels=['ready for review'];source.title='Renamed';f.label(1,'add',3);await f.gitlab.cycle();
  assert.equal(f.channels.length,2);assert.equal(f.gitlab.subscriptions().filter(s=>s.source_kind==='mr').length,1);
});
test('R02: label added and removed between scans still enrolls from label history, including a recently closed MR',async t=>{
  const f=fixture(t);const source=mr(1,[]);f.mrs.push(source);await f.configure();await f.gitlab.cycle();
  f.label(1,'add',1);f.label(1,'remove',2);source.state='closed';await f.gitlab.cycle();assert.equal(f.channels.length,2);
});
test('R02: baseline label IDs do not replay; newly observed label events on known MRs do not depend on clock alignment',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));f.labels.set(1,[{id:1,action:'add',created_at:stamp(-5000),label:{id:1,name:'ready for review'}}]);
  await f.configure();await f.gitlab.cycle();await f.gitlab.cycle();assert.equal(f.channels.length,1);
  f.mrs[0].labels=[];f.labels.get(1)!.push({id:2,action:'remove',created_at:stamp(-4000),label:{id:1,name:'ready for review'}},
    {id:3,action:'add',created_at:stamp(-3000),label:{id:1,name:'ready for review'}},
    {id:4,action:'remove',created_at:stamp(-2000),label:{id:1,name:'ready for review'}});
  await f.gitlab.cycle();assert.equal(f.channels.length,2);
});
test('R02: account change blocks discovery and existing MR reads, no watermark advance',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));await f.configure({initial:'follow'});await f.gitlab.cycle();
  const watermark=f.gitlab.watch.current()!.watermark;f.hooks.account=99;f.providerCalls.length=0;f.mrs.push(mr(2));await f.gitlab.cycle();
  assert.equal(f.gitlab.watch.current()!.watermark,watermark);assert.equal(f.channels.length,2);
  assert.ok(!f.providerCalls.some(c=>c.includes('/merge_requests')));assert.match(f.gitlab.watch.current()!.last_error!,/identity changed/);
});
test('R02: repository identity cannot silently change or rules silently replace each other',async t=>{
  const f=fixture(t);await f.configure();await assert.rejects(f.configure({label:'another'}),/already has/);
  f.hooks.project=9;await f.gitlab.cycle();assert.equal(f.gitlab.watch.current()!.initialized,0);assert.match(f.gitlab.watch.current()!.last_error!,/identity changed/);
});
test('R02: wrong brain/project and invalid selection cause no bot/channel writes',async t=>{
  const f=fixture(t);await assert.rejects(f.configure({brain:'Missing'}),/brain/);
  await assert.rejects(f.configure({authors:['all','me']}));
  assert.equal(f.agents.length,1);assert.equal(f.providerCalls.length,0);
  assert.throws(()=>repositoryPath(repository+'/-/merge_requests/1',f.gitlab.config));
  assert.throws(()=>watchSchema.parse({...f.spec,events:['shell']}));
});
test('R02: lost create receipt reconciles same channel after restart, no duplicate and no rule overwrite',async t=>{
  const f=fixture(t);await f.configure();await f.gitlab.cycle();f.mrs.push(mr(1));f.hooks.loseCreate=true;await f.gitlab.cycle();
  assert.equal(f.channels.length,2);assert.equal((f.gitlab.watch.status()!.jobs[0] as any).state,'pending');
  f.reopen();await f.gitlab.cycle();assert.equal(f.channels.length,2);assert.equal((f.gitlab.watch.status()!.jobs[0] as any).state,'ready');
  f.rooms.get(f.channels[1].id).contract.rules=['Human: analyze new comments'];f.reopen();await f.gitlab.cycle();
  assert.deepEqual(f.rooms.get(f.channels[1].id).contract.rules,['Human: analyze new comments']);
});
test('R02: unrelated channel-name collision blocks, never adopts it or creates an alternative',async t=>{
  const f=fixture(t);await f.configure();await f.gitlab.cycle();f.channels.push({id:'unrelated',name:'mr-42-1',type:'private',projectId:'p',memberIds:['brain'],topic:'Unrelated'});
  f.mrs.push(mr(1));await f.gitlab.cycle();assert.equal((f.gitlab.watch.status()!.jobs[0] as any).state,'blocked');
  assert.equal(f.gitlab.subscriptions().length,1);f.reopen();await f.gitlab.cycle();assert.equal(f.channels.length,2);
});
test('R02: permission rejection blocks setup without alternative identities or automatic retry',async t=>{
  const f=fixture(t);await f.configure();await f.gitlab.cycle();f.mrs.push(mr(1));f.hooks.denyCreate=403;await f.gitlab.cycle();
  assert.equal((f.gitlab.watch.status()!.jobs[0] as any).state,'blocked');const n=f.hiveCalls.filter(c=>c==='POST /api/ui/channels').length;
  f.hooks.denyCreate=0;await f.gitlab.cycle();assert.equal(f.hiveCalls.filter(c=>c==='POST /api/ui/channels').length,n);
});
test('R02/R03: archived discovery channel stops provider reads; room-only reopen stays paused',async t=>{
  const f=fixture(t);await f.configure();await f.gitlab.cycle();f.archive('summary',true);f.providerCalls.length=0;
  await f.gitlab.cycle();assert.equal(f.providerCalls.length,0);f.archive('summary',false,false);await f.gitlab.cycle();assert.equal(f.providerCalls.length,0);
  f.archive('summary',false,true);await f.gitlab.cycle();assert.ok(f.providerCalls.length>0);
});
test('R02/R03: MR archive stops its reads without preventing new MR discovery; unfollow is never reversed',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));const w=await f.configure({initial:'follow'});await f.gitlab.cycle();
  const channel=f.channels[1];f.archive(channel.id,true);f.providerCalls.length=0;f.mrs.push(mr(2));await f.gitlab.cycle();
  assert.ok(!f.providerCalls.some(c=>/merge_requests\/1(?:[/?]|$)/.test(c)));assert.equal(f.channels.length,3);
  const sub=f.gitlab.subscriptions().find(s=>s.channel===channel.id)!;f.gitlab.unfollow(sub.id);
  f.archive(channel.id,false);f.gitlab.watch.takeExisting(w.id);await f.gitlab.cycle();assert.equal(f.gitlab.subscriptions().find(s=>s.id===sub.id)!.enabled,0);
});
test('R02: stop-watch stops discovery only, resume does not launch a monitor',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));const w=await f.configure({initial:'follow'});await f.gitlab.cycle();
  await f.gitlab.watch.setEnabled(w.id,false);f.mrs.push(mr(2));await f.gitlab.cycle();assert.equal(f.channels.length,2);
  assert.equal((await f.gitlab.watch.setEnabled(w.id,true)).monitorStarted,false);assert.equal(f.gitlab.isRunning(),false);
  await f.gitlab.cycle();assert.equal(f.channels.length,3);
});
test('disabled discovery reconciles stop and archive state without provider reads, including failed reports',async t=>{
  const f=fixture(t),w=await f.configure();await f.gitlab.cycle();
  const sub=f.gitlab.watch.current()!.subscription,link=f.links.get('summary:'+sub)!;
  assert.equal(link.observed,'running');
  await f.gitlab.watch.setEnabled(w.id,false);f.providerCalls.length=0;
  await f.gitlab.cycle();assert.equal(link.observed,'failed');
  assert.match(link.detail,/explicitly unfollowed/);
  const callsAfterStop=f.hiveCalls.length;
  await f.gitlab.cycle(undefined,true);
  assert.equal(f.hiveCalls.length,callsAfterStop,'Disabled discovery keeps the existing five-second lifecycle throttle');
  f.archive('summary',true);
  const original=f.gitlab.request.bind(f.gitlab);let rejectReport=true;
  t.mock.method(f.gitlab,'request',async (route:string,options?:RequestInit,signal?:AbortSignal)=>{
    if(rejectReport && route.endsWith('/status'))throw new Error('fixture report unavailable');
    return original(route,options,signal);
  });
  await f.gitlab.cycle();assert.equal(f.gitlab.lifecycle.state(sub)!.applied,'failed');
  assert.equal(link.observed,'pending');
  rejectReport=false;
  await f.gitlab.cycle();assert.equal(link.observed,'paused');
  f.archive('summary',false);
  await f.gitlab.cycle();assert.equal(link.observed,'failed');
  assert.equal(f.gitlab.watch.current()!.enabled,0);
  assert.deepEqual(f.providerCalls,[]);assert.equal(f.channels.length,1);
  assert.equal(f.gitlab.isRunning(),false);
});
test('discovery enablement rolls back both local flags when a write fails',async t=>{
  const f=fixture(t),w=await f.configure();
  const sub=f.gitlab.watch.current()!.subscription;
  f.gitlab.db.exec("CREATE TEMP TRIGGER reject_discovery_flag BEFORE UPDATE OF enabled ON subscriptions BEGIN SELECT RAISE(ABORT,'fixture rejected subscription flag'); END");
  await assert.rejects(f.gitlab.watch.setEnabled(w.id,false),/fixture rejected/);
  assert.equal(f.gitlab.watch.current()!.enabled,1);
  assert.equal(f.gitlab.subscriptions().find(s=>s.id===sub)!.enabled,1);
});
test('R02: selective events suppress unrelated changes while advancing fingerprints; new comments differ from edits',async t=>{
  const f=fixture(t);const source=mr(1);f.mrs.push(source);f.notes.set(1,[note(1)]);
  await f.configure({initial:'follow',events:['comment','conflict']});await f.gitlab.cycle();const start=f.messages.size;
  f.notes.get(1)![0].body='An edited old comment';source.title='Changed title';source.detailed_merge_status='checking';source.has_conflicts=true;await f.gitlab.cycle();assert.equal(f.messages.size,start);
  source.detailed_merge_status='conflict';f.notes.get(1)!.push(note(2,'New comment'));await f.gitlab.cycle();assert.equal(f.messages.size,start+2);
  await f.gitlab.cycle();assert.equal(f.messages.size,start+2);
  assert.ok(!f.providerCalls.some(c=>c.endsWith('/approvals')));
});
test('R02: merge/close event delivered after label removal, approval changes and label history are collected',async t=>{
  const f=fixture(t);const source=mr(1);f.mrs.push(source);await f.configure({initial:'follow'});await f.gitlab.cycle();const n=f.messages.size;
  source.labels=[];source.state='merged';f.label(1,'remove',4);f.approve();await f.gitlab.cycle();
  const newMessages=[...f.messages.values()].slice(n);assert.ok(newMessages.some(m=>m.body.includes('State: merged')));
  assert.ok(newMessages.some(m=>m.body.includes('label rimossa')));assert.ok(newMessages.some(m=>m.body.includes('approvazioni correnti: @reviewer')));
});
test('R02: deleted/renamed labels do not replay historical resource-label events',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));f.labels.set(1,[{id:1,action:'add',created_at:stamp(-5000),label:{id:1,name:'ready for review'}}]);
  await f.configure({initial:'follow'});await f.gitlab.cycle();const n=f.messages.size;
  f.labels.get(1)![0].label=null;await f.gitlab.cycle();assert.equal(f.messages.size,n);
});
test('R02: comments arriving during channel setup are not lost with the initial baseline',async t=>{
  const f=fixture(t);await f.configure();await f.gitlab.cycle();f.mrs.push(mr(1));
  f.hooks.beforeGet=p=>{if(p.includes('/discussions?')&&!f.notes.has(1))f.notes.set(1,[note(1,'Before enrollment'),note(2,'After enrollment',5)]);};
  await f.gitlab.cycle();assert.ok([...f.messages.values()].some(m=>m.body.includes('After enrollment')));
  assert.ok(![...f.messages.values()].some(m=>m.body.includes('Before enrollment')));
});
test('R02: incomplete pagination/duplicate pages fail closed; no partial initialization or channels',async t=>{
  const f=fixture(t);await f.configure();for(let i=1;i<=500;i++)f.mrs.push(mr(i));await f.gitlab.cycle();
  assert.equal(f.gitlab.watch.current()!.initialized,0);assert.equal(f.channels.length,1);assert.equal(f.messages.size,0);
  const reader=new WatchReader(f.gitlab.config,f.home,async()=>({stdout:JSON.stringify(Array.from({length:100},(_,i)=>({id:i+1})))}));
  const {z}=await import('zod/v3');await assert.rejects(reader.pages('fixture',z.object({id:z.number()})),/repeated/);
});
test('R02: abort or archive while reading does not commit partial discovery',async t=>{
  const f=fixture(t);await f.configure();f.mrs.push(mr(1));const controller=new AbortController();
  f.hooks.beforeGet=p=>{if(p.includes('/merge_requests?'))controller.abort();};await f.gitlab.cycle(undefined,false,controller.signal);
  assert.equal(f.gitlab.watch.current()!.initialized,0);assert.equal(f.channels.length,1);assert.equal(f.messages.size,0);
});
test('R02: initial summary is bounded and stable across restarts; status contains no bot credentials',async t=>{
  const f=fixture(t);for(let i=1;i<=70;i++)f.mrs.push({...mr(i),title:'Long '.repeat(150)});await f.configure();await f.gitlab.cycle();
  assert.ok(f.messages.size>1);assert.ok([...f.messages.values()].every(m=>m.body.length<=3940));
  const n=f.messages.size;f.reopen();await f.gitlab.cycle();assert.equal(f.messages.size,n);
  assert.ok(!JSON.stringify(f.gitlab.status()).includes('synthetic-only-'));assert.equal(eventTypes.length,10);
});

function manualChannel(f:ReturnType<typeof fixture>,id='manual') {
  const channel={id,name:'native-navigation-'+id,type:'private',projectId:'p',memberIds:['human','brain'],topic:'Human-selected MR channel'};
  f.channels.push(channel);
  f.rooms.set(id,{revision:7,state:'active',coordinatorId:'brain',contract:{mode:'ongoing',rules:['Reviews go to the Human-selected worker; no automatic work.']}});
  return channel;
}
test('R02 reuse: label reentry reuses a manual MR channel, preserving contract, subscription and history across restart',async t=>{
  const f=fixture(t);const source=mr(1);f.mrs.push(source);await f.configure();await f.gitlab.cycle();
  const channel=manualChannel(f);const linked=await f.gitlab.follow(source.web_url+'#note_123',channel.id);await f.gitlab.cycle();
  source.labels=[];f.label(1,'remove',10);await f.gitlab.cycle();
  const contract=structuredClone(f.rooms.get(channel.id));
  const before={sub:f.gitlab.subscriptions().find(s=>s.id===linked.id),items:f.gitlab.db.prepare('SELECT * FROM items WHERE subscription=?').all(linked.id),
    events:f.gitlab.db.prepare('SELECT * FROM events WHERE subscription=?').all(linked.id)};
  source.labels=['ready for review'];f.label(1,'add',11);f.hiveCalls.length=0;await f.gitlab.watch.cycle();
  assert.equal(f.channels.length,2,'must not create a second MR channel');
  assert.equal(f.gitlab.subscriptions().filter(s=>s.source_kind==='mr').length,1);
  const route=f.gitlab.watch.status()!.routes[0] as any;
  assert.equal(route.channel,channel.id);assert.equal(route.subscription,linked.id);assert.equal(route.origin,'existing');
  assert.deepEqual(f.rooms.get(channel.id),contract);
  assert.deepEqual(f.gitlab.subscriptions().find(s=>s.id===linked.id),before.sub);
  assert.deepEqual(f.gitlab.db.prepare('SELECT * FROM items WHERE subscription=?').all(linked.id),before.items);
  assert.deepEqual(f.gitlab.db.prepare('SELECT * FROM events WHERE subscription=?').all(linked.id),before.events);
  assert.ok(!f.hiveCalls.some(c=>c.startsWith('POST /api/ui/')));
  f.reopen();await f.gitlab.cycle();const count=f.messages.size;
  f.gitlab.watch.takeExisting(f.gitlab.watch.current()!.id);await f.gitlab.cycle();
  assert.equal(f.messages.size,count);assert.equal(f.channels.length,2);assert.deepEqual(f.rooms.get(channel.id),contract);
});
test('R02 reuse: manual follow before initial discovery keeps its event selection and baseline',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));const channel=manualChannel(f);
  const sub=await f.gitlab.follow(f.mrs[0].web_url,channel.id,'baseline');
  await f.configure({initial:'follow',events:['comment']});await f.gitlab.watch.cycle();
  assert.equal(f.channels.length,2);assert.equal(f.gitlab.watch.status()!.routes[0]!.channel,channel.id);
  const saved=f.gitlab.subscriptions().find(s=>s.id===sub.id)!;
  assert.equal(saved.initial,'baseline');assert.equal(saved.event_filter,null);assert.equal(saved.observed_after,null);
  assert.equal(f.gitlab.db.prepare('SELECT count(*) n FROM events WHERE subscription=?').get(sub.id)!.n,0);
});
for(const mode of ['paused','unfollowed'] as const)test('R02 reuse: '+mode+' manual sources are pinned without resuming them',async t=>{
  const f=fixture(t);const source=mr(1,[]);f.mrs.push(source);await f.configure();await f.gitlab.cycle();
  const channel=manualChannel(f);const sub=await f.gitlab.follow(source.web_url,channel.id);await f.gitlab.cycle();
  if(mode==='paused') {f.archive(channel.id,true);f.rooms.get(channel.id).state='archived';}
  else f.gitlab.unfollow(sub.id);
  source.labels=['ready for review'];f.label(1,'add',11);f.providerCalls.length=0;const n=f.messages.size;
  await f.gitlab.cycle();assert.equal(f.channels.length,2);assert.equal(f.messages.size,n);
  assert.equal(f.gitlab.watch.status()!.routes[0]!.channel,channel.id);
  assert.equal(f.gitlab.subscriptions().find(s=>s.id===sub.id)!.enabled,mode==='unfollowed'?0:1);
  assert.equal(f.gitlab.lifecycle.state(sub.id)!.applied,mode==='paused'?'paused':'disabled');
  assert.ok(!f.providerCalls.some(c=>/merge_requests\/1(?:\?|\/discussions)/.test(c)));
  f.reopen();f.gitlab.watch.takeExisting(f.gitlab.watch.current()!.id);await f.gitlab.cycle();
  assert.equal(f.channels.length,2);assert.equal(f.messages.size,n);
});
test('R02 reuse: two manual destinations including an unfollowed one are ambiguous, not a third channel',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));await f.configure({initial:'follow'});
  for(const id of ['one','two']){const channel=manualChannel(f,id);const sub=await f.gitlab.follow(f.mrs[0].web_url,channel.id);if(id==='two')f.gitlab.unfollow(sub.id);}
  const before=f.gitlab.subscriptions();await f.gitlab.watch.cycle();
  assert.equal(f.channels.length,3);assert.equal(f.gitlab.watch.status()!.routes.length,0);
  assert.match(String(f.gitlab.watch.status()!.jobs[0]!.error),/multiple existing links/);
  assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'blocked');assert.deepEqual(f.gitlab.subscriptions(),before);
  f.reopen();await f.gitlab.watch.cycle();assert.equal(f.channels.length,3);
});
for(const incompatible of ['public','other-project','missing-channel','missing-brain','missing-human','missing-bot','missing-room','other-coordinator','multi-source','canonical-collision'])
test('R02 reuse: incompatible '+incompatible+' fails closed without altering an existing room',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));await f.configure({initial:'follow'});
  const channel=manualChannel(f);await f.gitlab.follow(f.mrs[0].web_url,channel.id);
  if(incompatible==='public')channel.type='public';
  if(incompatible==='other-project')channel.projectId='other';
  if(incompatible==='missing-channel')f.channels.splice(f.channels.indexOf(channel),1);
  if(incompatible==='missing-brain')channel.memberIds=channel.memberIds.filter(id=>id!=='brain');
  if(incompatible==='missing-human')channel.memberIds=channel.memberIds.filter(id=>id!=='human');
  if(incompatible==='missing-bot')channel.memberIds=channel.memberIds.filter(id=>!id.startsWith('bot'));
  if(incompatible==='missing-room')f.rooms.delete(channel.id);
  if(incompatible==='other-coordinator')f.rooms.get(channel.id).coordinatorId='another-brain';
  if(incompatible==='multi-source')await f.gitlab.follow(repository+'/-/merge_requests/2',channel.id);
  if(incompatible==='canonical-collision')f.channels.push({...channel,id:'other-channel',name:'mr-42-1'});
  const channels=structuredClone(f.channels),rooms=structuredClone(f.rooms),subs=f.gitlab.subscriptions();
  await f.gitlab.watch.cycle();assert.deepEqual(f.channels,channels);assert.deepEqual(f.rooms,rooms);assert.deepEqual(f.gitlab.subscriptions(),subs);
  assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'blocked');assert.equal(f.gitlab.watch.status()!.routes.length,0);
});
test('R02 reuse: denied room lookup blocks without fallback; unavailable lookup retries the same manual link',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));await f.configure({initial:'follow'});const channel=manualChannel(f);
  await f.gitlab.follow(f.mrs[0].web_url,channel.id);const request=f.gitlab.request.bind(f.gitlab);
  f.gitlab.request=async(...args)=>{if(args[0].endsWith('/room'))throw new Error('temporarily unavailable');return request(...args);};
  await f.gitlab.watch.cycle();assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'pending');assert.equal(f.channels.length,2);
  f.reopen();await f.gitlab.watch.cycle();assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'ready');assert.equal(f.channels.length,2);
  // A second MR with a permission denial must not fall back to auto-provisioning.
  f.mrs.push(mr(2));const other=manualChannel(f,'second');await f.gitlab.follow(f.mrs[1].web_url,other.id);
  const allowed=f.gitlab.request.bind(f.gitlab);
  f.gitlab.request=async(...args)=>{if(args[0].endsWith('/room'))throw new HiveHttpError(403);return allowed(...args);};
  await f.gitlab.watch.cycle();assert.equal(f.gitlab.watch.status()!.jobs[1]!.state,'blocked');assert.equal(f.channels.length,3);
  f.reopen();await f.gitlab.watch.cycle();assert.equal(f.channels.length,3);assert.equal(f.gitlab.watch.status()!.jobs[1]!.state,'blocked');
});
test('R02 reuse: current discovery routes survive reopen without duplicate channels',async t=>{
  const f=fixture(t);f.mrs.push(mr(1));await f.configure({initial:'follow'});await f.gitlab.cycle();
  f.reopen();
  assert.equal(f.gitlab.watch.status()!.routes[0]!.origin,'discovery');await f.gitlab.cycle();assert.equal(f.channels.length,2);
});

test('descriptive channel name and topic are pinned through a title edit, lost response and restart',async t=>{
  const f=fixture(t,true),source={...mr(1),title:'feat(APP-123): adopt scene lifecycle'};
  await f.configure();await f.gitlab.cycle();f.mrs.push(source);f.hooks.loseCreate=true;await f.gitlab.cycle();
  const channel=structuredClone(f.channels[1]);
  assert.equal(channel.name,'mr-1-adopt-scene-lifecycle-p42');
  assert.ok(channel.topic.startsWith(source.title+'\nGitLab MR: '+source.web_url));
  assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'pending');
  source.title='fix(APP-123): renamed after channel creation';
  // Even a refreshed pending-job payload cannot replace its recorded name/topic.
  f.gitlab.db.prepare('UPDATE watch_jobs SET mr=? WHERE url=?').run(JSON.stringify(source),source.web_url);
  f.reopen();await f.gitlab.cycle();
  assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'ready');assert.equal(f.channels.length,2);
  assert.equal(f.channels[1].id,channel.id);assert.equal(f.channels[1].name,channel.name);assert.equal(f.channels[1].topic,channel.topic);
  assert.equal(f.gitlab.subscriptions().filter(s=>s.source_kind==='mr').length,1);
});

test('long titles keep topics bounded without losing the canonical MR link or source marker',async t=>{
  const f=fixture(t),source={...mr(1),title:'Very long subject '.repeat(500)};
  f.mrs.push(source);await f.configure({initial:'follow'});await f.gitlab.cycle();
  assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'ready');const channel=f.channels[1];
  assert.ok(channel.name.length<=100);assert.ok(channel.topic.length<=4000);
  assert.ok(channel.topic.includes('…\nGitLab MR: '+source.web_url));assert.match(channel.topic,/Managed source: [a-f0-9]{24}/);
});

for(const recorded of [false,true])test('pre-upgrade lost create receipt preserves legacy metadata, recorded route: '+recorded,async t=>{
  const f=fixture(t,true),source=mr(1);f.mrs.push(source);await f.configure({initial:'follow'});
  const name='mr-42-1',marker=createHash('sha256').update(JSON.stringify(['p',source.web_url])).digest('hex').slice(0,24);
  const topic=`GitLab MR: ${source.web_url}\nManaged source: ${marker}\nRaccolta aggiornamenti. Review e analisi solo su istruzione Human; nessuna pubblicazione automatica.`;
  f.channels.push({id:'legacy',name,topic,type:'private',projectId:'p',memberIds:['human','brain']});
  if(recorded)f.gitlab.db.prepare('INSERT INTO mr_routes(url,name,topic) VALUES (?,?,?)').run(source.web_url,name,topic);
  f.reopen();await f.gitlab.cycle();
  assert.equal(f.channels.length,2);assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'ready');
  const route=f.gitlab.watch.status()!.routes[0]!;
  assert.equal(route.channel,'legacy');assert.equal(route.name,name);assert.equal(f.channels[1].topic,topic);
  assert.ok(!f.hiveCalls.includes('POST /api/ui/channels'));
});

for(const stopped of ['archived','unfollowed'] as const)test('existing legacy route keeps '+stopped+' source and Human contract without replay',async t=>{
  const f=fixture(t,true),source=mr(1);f.mrs.push(source);await f.configure({initial:'follow'});await f.gitlab.cycle();
  const channel=f.channels[1],route=f.gitlab.watch.status()!.routes[0]!;
  // Model a retained pre-upgrade route with historical name/topic and events.
  channel.name='mr-42-1';channel.topic='Retained legacy topic';
  f.gitlab.db.prepare('UPDATE mr_routes SET name=?,topic=? WHERE url=?').run(channel.name,channel.topic,source.web_url);
  f.rooms.get(channel.id).contract.instructions='Human custom rules; do not overwrite.';
  if(stopped==='archived'){f.archive(channel.id,true);f.rooms.get(channel.id).state='archived';}
  else f.gitlab.unfollow(String(route.subscription));
  const before={channel:structuredClone(channel),room:structuredClone(f.rooms.get(channel.id)),events:f.gitlab.db.prepare('SELECT * FROM events').all()};
  source.title='Changed title';f.reopen();await f.gitlab.cycle();
  assert.equal(f.channels.length,2);assert.deepEqual(f.channels[1],before.channel);assert.deepEqual(f.rooms.get(channel.id),before.room);
  assert.deepEqual(f.gitlab.db.prepare('SELECT * FROM events').all(),before.events);
  assert.equal(f.gitlab.subscriptions().find(s=>s.id===route.subscription)!.enabled,stopped==='archived'?1:0);
});

test('unrelated descriptive-name collision blocks without adopting or creating an alternative',async t=>{
  const f=fixture(t),source=mr(1);await f.configure();await f.gitlab.cycle();
  f.channels.push({id:'unrelated',name:mrChannelName(42,1,source.title),type:'private',projectId:'p',memberIds:['human','brain'],topic:'Not this MR'});
  f.mrs.push(source);await f.gitlab.cycle();
  assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'blocked');assert.equal(f.channels.length,2);
  assert.equal(f.gitlab.subscriptions().length,1);
});

test('manual follow cannot hide a conflicting descriptive discovery channel',async t=>{
  const f=fixture(t),source=mr(1);f.mrs.push(source);await f.configure({initial:'follow'});
  const channel=manualChannel(f);await f.gitlab.follow(source.web_url,channel.id);
  f.channels.push({...channel,id:'other',name:mrChannelName(42,1,source.title)});
  const before=structuredClone(f.channels);await f.gitlab.watch.cycle();
  assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'blocked');assert.deepEqual(f.channels,before);
});

test('both legacy and descriptive unlinked channels block instead of choosing one',async t=>{
  const f=fixture(t),source=mr(1);f.mrs.push(source);await f.configure({initial:'follow'});
  for(const name of ['mr-42-1',mrChannelName(42,1,source.title)])f.channels.push({id:name,name,type:'private',projectId:'p',memberIds:['human','brain'],topic:'Existing'});
  await f.gitlab.cycle();assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'blocked');
  assert.equal(f.channels.length,3);assert.equal(f.gitlab.subscriptions().length,1);
});

test('a legacy channel appearing after a descriptive route was journaled blocks duplicate creation',async t=>{
  const f=fixture(t),source=mr(1);f.mrs.push(source);await f.configure({initial:'follow'});
  // A prior attempt persisted its new name, but did not reach channel creation.
  f.gitlab.db.prepare('INSERT INTO mr_routes(url,name,topic) VALUES (?,?,?)')
    .run(source.web_url,mrChannelName(42,1,source.title),'Pinned pending topic');
  f.channels.push({id:'legacy',name:'mr-42-1',type:'private',projectId:'p',memberIds:['human','brain'],topic:'Existing legacy topic'});
  await f.gitlab.cycle();assert.equal(f.gitlab.watch.status()!.jobs[0]!.state,'blocked');
  assert.equal(f.channels.length,2);assert.equal(f.gitlab.subscriptions().length,1);
  assert.ok(!f.hiveCalls.includes('POST /api/ui/channels'));
});
