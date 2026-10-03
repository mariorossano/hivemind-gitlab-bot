import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os'; import path from 'node:path';
import { configSchema, parseSource, read } from '../src/provider.ts';
import { GitLabBot, init } from '../src/runtime.ts';
import { runCommand, type Runner } from '../src/readers/process.ts';
const url = 'https://gitlab.example.invalid/demo/repo/-/merge_requests/7';
const config = configSchema.parse({ hiveUrl:'http://127.0.0.1:12345',host:'gitlab.example.invalid',executable:'/invented/glab' });
const mr = { id:45,iid:7,project_id:12,title:'Invented MR',state:'opened',web_url:url,sha:'a'.repeat(40),source_branch:'fixture',target_branch:'main',updated_at:'2030-01-01T12:00:00Z',author:{name:'Example'},description:'Invented' };
const note = { id:101,body:'Invented comment',author:{name:'Reviewer'},created_at:mr.updated_at,updated_at:mr.updated_at,system:false,resolved:false,resolvable:true };
function temp(t:any) { const dir=mkdtempSync(path.join(os.tmpdir(),'gitlab-gitlab-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); return dir; }
test('exact MR URLs normalize, reject wrong host and malformed scopes',()=>{
  assert.equal(parseSource(url+'#note_1',config).url,url);
  for(const bad of ['http://gitlab.example.invalid/demo/repo/-/merge_requests/7',url.replace('/7','/0'),url.replace('example.invalid','other.invalid'),url.replace('/7','/7/diffs')]) assert.throws(()=>parseSource(bad,config));
});
test('glab is GET-only; MR head/status/comments/replies/resolution and links are retained',async t=>{
  const dir=temp(t); const commands:any[]=[];
  const runner:Runner=async command=>{ commands.push(command); return {stdout:JSON.stringify(command.args[1]!.includes('/discussions?')?[{id:'d',individual_note:false,notes:[note,{...note,id:102,body:'Reply',resolved:true}]}]:{...mr,state:'merged',sha:'b'.repeat(40)})}; };
  const snapshot=await read(url,config,dir,runner);
  assert.equal(snapshot.observations.length,4); assert.match(snapshot.observations[0]!.body,/merged/);
  const reply = snapshot.observations.find(o=>o.key==='note:102')!;
  assert.match(reply.body,/Reply.*resolved/s); assert.ok(reply.url.endsWith('#note_102'));
  assert.ok(commands.every(c=>c.args[1].startsWith('projects/demo%2Frepo/merge_requests/7') && c.args[c.args.indexOf('--method')+1]==='GET'));
});
test('pagination, wrong MR and incomplete data do not establish a snapshot',async t=>{
  const dir=temp(t);
  const full=Array.from({length:100},(_,i)=>({id:String(i),individual_note:false,notes:[{...note,id:i+1,system:true}]}));
  const runner:Runner=async c=>({stdout:JSON.stringify(!c.args[1]!.includes('/discussions?')?mr:c.args[1]!.endsWith('page=1')?full:[])});
  await assert.rejects(read(url,{...config,maxPages:1},dir,runner),/page limit/);
  assert.equal((await read(url,{...config,maxPages:2},dir,runner)).observations.length,2);
  await assert.rejects(read(url,config,dir,async()=>({stdout:JSON.stringify({...mr,iid:9})})),/different MR/);
});
test('inline comments and replies accept null diff paths and retain available locations',async t=>{
  const dir=temp(t);
  const positions=[
    {new_path:'Added.swift',old_path:null,new_line:12,old_line:null},
    {new_path:null,old_path:'Removed.swift',new_line:null,old_line:9},
    {new_path:null,old_path:null,new_line:null,old_line:null},
    {new_path:'Existing.swift',old_path:'Existing.swift',new_line:4,old_line:3},
    {new_path:'Optional.swift',new_line:7},
    {old_path:'OldOptional.swift',old_line:8},
    null,undefined,
  ];
  const expected=['Added.swift:12','Removed.swift:9','diff:','Existing.swift:4','Optional.swift:7','OldOptional.swift:8'];
  const notes=positions.map((position,index)=>({...note,id:101+index,position}));
  const result=await read(url,config,dir,async c=>({stdout:JSON.stringify(c.args[1]!.includes('/discussions?')?
    [{id:'position-fixture',individual_note:false,notes}]:mr)}));
  const comments=result.observations.filter(o=>o.key.startsWith('note:'));
  assert.equal(comments.length,positions.length);
  comments.forEach((o,index)=>{
    assert.deepEqual((o.value as any).position,positions[index]??null);
    assert.ok(o.url.endsWith('#note_'+(101+index)));
    assert.ok(o.body.startsWith(index===0?'Comment':'Reply'));
    if(expected[index])assert.ok(o.body.includes(expected[index]!));
    else assert.doesNotMatch(o.body,/ · diff:|undefined|null/);
  });
});
test('null diff paths do not relax other malformed path or note validation',async t=>{
  const dir=temp(t);
  for(const field of ['new_path','old_path'])for(const invalid of [7,false,[],{}]) {
    await assert.rejects(read(url,config,dir,async c=>({stdout:JSON.stringify(c.args[1]!.includes('/discussions?')?
      [{id:'bad-path',individual_note:false,notes:[{...note,position:{new_path:null,old_path:null,[field]:invalid}}]}]:mr)})),
      (error:any)=>error.issues?.some((issue:any)=>issue.path.at(-1)===field && issue.code==='invalid_type'));
  }
  await assert.rejects(read(url,config,dir,async c=>({stdout:JSON.stringify(c.args[1]!.includes('/discussions?')?
    [{id:'bad-note',individual_note:false,notes:[{...note,body:null,position:{old_path:null}}]}]:mr)})));
});
test('null-path notes initialize a snapshot, deduplicate, and retain one new event after restart',async t=>{
  const dir=temp(t);init(dir,config);
  let gitlab=new GitLabBot(dir);t.after(()=>gitlab.close());
  gitlab.db.prepare("INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES ('s',?,'one','b',1,'snapshot')").run(url);
  let notes=[{...note,position:{new_path:'Added.swift',old_path:null,new_line:12,old_line:null}}];
  const snapshot=()=>read(url,config,dir,async c=>({stdout:JSON.stringify(c.args[1]!.includes('/discussions?')?
    [{id:'retained',individual_note:false,notes}]:mr)}));
  const sub=()=>gitlab.subscriptions()[0]!;
  assert.equal(gitlab.apply(sub(),await snapshot()),3);
  assert.equal(sub().initialized,1);
  assert.equal(gitlab.apply(sub(),await snapshot()),0);
  const before=gitlab.db.prepare('SELECT event FROM events ORDER BY id').all();
  gitlab.close();gitlab=new GitLabBot(dir);
  assert.equal(gitlab.apply(sub(),await snapshot()),0);
  assert.deepEqual(gitlab.db.prepare('SELECT event FROM events ORDER BY id').all(),before);
  notes=[...notes,{...notes[0]!,id:102,body:'New reply after restart'}];
  assert.equal(gitlab.apply(sub(),await snapshot()),1);
  assert.equal(gitlab.apply(sub(),await snapshot()),0);
  const event=JSON.parse(String(gitlab.db.prepare('SELECT event FROM events ORDER BY id DESC LIMIT 1').get()!.event));
  assert.equal(event.origin.url,url+'#note_102');
  assert.match(event.body,/Reply.*Added.swift:12.*New reply after restart/s);
});
test('one provider read per URL serves multiple channel subscriptions',async t=>{
  const dir=temp(t); init(dir,config); let calls=0;
  const p=new GitLabBot(dir,async c=>{calls++;return {stdout:JSON.stringify(c.args[1]!.includes('/discussions?')?[]:mr)};});
  t.after(()=>p.close());
  p.db.prepare('INSERT INTO bots VALUES (?,?,?,?)').run('p','b','GitLab','fixture-only');
  p.request=async route=>{const id=route.split('/')[4]!;return {links:[{id,botId:'b',label:'GitLab source '+id,suspendSupported:true,desired:'running',generation:1,observed:'running',detail:''}]};};
  for(const id of ['one','two']) p.db.prepare("INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES (?,?,?,'b',1,'baseline')").run(id,url,id);
  const result=await p.cycle(); assert.equal(result.length,2); assert.equal(calls,2); // MR + discussions, not twice per channel.
});
test('actual configurable glab executable and bounded process cancellation',async t=>{
  const dir=temp(t), executable=path.join(dir,'fake-glab.mjs');
  writeFileSync(executable,'#!'+process.execPath+'\nif(process.argv[2]!=="api" || process.argv[process.argv.indexOf("--method")+1]!=="GET")process.exit(9);console.log(JSON.stringify(process.argv[3].includes("/discussions?")?[]:'+JSON.stringify(mr)+'));',{mode:0o700});
  assert.equal((await read(url,{...config,executable},dir,runCommand)).observations.length,2);
  const fixture=path.join(dir,'wait.mjs'); writeFileSync(fixture,'console.error("private");setInterval(()=>{},1000)');
  await assert.rejects(runCommand({executable:process.execPath,args:[fixture],cwd:dir,timeoutMs:100}),/timed out/);
});

const healthy = {
  ...mr, merge_status:'can_be_merged', detailed_merge_status:'mergeable', has_conflicts:false,
  diverged_commits_count:0, rebase_in_progress:false,
  head_pipeline:{id:501,status:'success',sha:mr.sha,web_url:'https://gitlab.example.invalid/demo/repo/-/pipelines/501'},
};
async function readFixture(dir:string, data:unknown, source=url) {
  return read(source,config,dir,async c=>({stdout:JSON.stringify(c.args[1]!.includes('/discussions?')?[]:data)}));
}
test('merge health requests behind/rebase fields and reports conflicts, target and head pipeline',async t=>{
  const dir=temp(t), commands:any[]=[];
  const result=await read(url,config,dir,async c=>{commands.push(c);return {stdout:JSON.stringify(c.args[1]!.includes('/discussions?')?[]:{...healthy,diverged_commits_count:8})};});
  assert.match(commands[0].args[1],/include_diverged_commits_count=true&include_rebase_in_progress=true/);
  const health=result.observations.find(o=>o.key==='health')!;
  assert.deepEqual(health.value,{state:'opened',target:'main',mergeStatus:'mergeable',conflicts:'none_reported',divergedCommits:8,rebaseInProgress:false,
    pipeline:{id:501,status:'success',sha:mr.sha,url:healthy.head_pipeline.web_url,matchesHead:true}});
  assert.match(health.body,/MR !7.*merge health/s);
  assert.match(health.body,/Behind target: 8 commit/);
  assert.match(health.body,/success · current head/);
  assert.equal(health.url,url);
});
test('pending and unavailable GitLab checks never claim confirmed absence of conflicts or zero behind',async t=>{
  const dir=temp(t);
  for(const status of ['checking','unchecked','preparing','cannot_be_merged_recheck']) {
    const snapshot=await readFixture(dir,{...healthy,detailed_merge_status:status});
    assert.match(snapshot.observations[1]!.body,/Conflicts: check pending/);
    assert.doesNotMatch(snapshot.observations[1]!.body,/Conflicts: none reported/);
  }
  const unknown=(await readFixture(dir,mr)).observations[1]!;
  assert.match(unknown.body,/Merge status: unknown/);
  assert.match(unknown.body,/Conflicts: unknown/);
  assert.match(unknown.body,/Behind target: unknown/);
  assert.match(unknown.body,/Pipeline: unavailable/);
});
test('changed health queues one compact observation and identical polls stay silent, including after restart',async t=>{
  const dir=temp(t);init(dir,config);
  let gitlab=new GitLabBot(dir);t.after(()=>gitlab.close());
  gitlab.db.prepare("INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES ('s',?,'one','b',1,'baseline')").run(url);
  const sub=()=>gitlab.subscriptions()[0]!;
  let data:any=healthy;
  assert.equal(gitlab.apply(sub(),await readFixture(dir,data)),0);
  for(const patch of [
    {has_conflicts:true,merge_status:'cannot_be_merged',detailed_merge_status:'conflict'},
    {has_conflicts:false,merge_status:'can_be_merged',detailed_merge_status:'mergeable'},
    {diverged_commits_count:8},
    {head_pipeline:{...healthy.head_pipeline,status:'failed'}},
    {head_pipeline:{...healthy.head_pipeline,status:'success'}},
    {rebase_in_progress:true},
  ]) {
    data={...data,...patch};
    assert.equal(gitlab.apply(sub(),await readFixture(dir,data)),1);
    assert.equal(gitlab.apply(sub(),await readFixture(dir,{...data,updated_at:'2030-01-02T12:00:00Z'})),0);
  }
  const events=gitlab.db.prepare('SELECT event FROM events ORDER BY id').all().map(e=>JSON.parse(String(e.event)));
  assert.equal(events.length,6);
  assert.ok(events.every(e=>e.origin.url===url && e.body.includes('MR !7 · Invented MR · merge health') && !e.body.includes('Invented comment')));
  assert.match(events[0].body,/Conflicts: YES/);assert.match(events[3].body,/Pipeline: #501 failed/);
  assert.equal(new Set(events.map(e=>e.eventId)).size,6);
  gitlab.close();gitlab=new GitLabBot(dir);
  assert.equal(gitlab.apply(sub(),await readFixture(dir,data)),0);
});
test('a successful old pipeline does not validate a new head; missing values and invalid health stay explicit',async t=>{
  const dir=temp(t);
  const old=(await readFixture(dir,{...healthy,sha:'b'.repeat(40)})).observations[1]!;
  assert.match(old.body,/different\/older head — does not validate the current head/);
  const missing=(await readFixture(dir,{...healthy,head_pipeline:null,has_conflicts:null,diverged_commits_count:null})).observations[1]!;
  assert.match(missing.body,/Conflicts: unknown/);assert.match(missing.body,/Behind target: unknown/);
  for(const patch of [{diverged_commits_count:-1},{has_conflicts:'false'},{head_pipeline:{id:501}},{head_pipeline:{...healthy.head_pipeline,web_url:'https://wrong.invalid/pipeline'}}])
    await assert.rejects(readFixture(dir,{...healthy,...patch}));
});
test('multiple MRs in one channel keep separate health histories and changed-MR links',async t=>{
  const dir=temp(t);init(dir,config);const gitlab=new GitLabBot(dir);t.after(()=>gitlab.close());
  const secondUrl=url.replace('/7','/8');
  for(const [id,source] of [['one',url],['two',secondUrl]])
    gitlab.db.prepare("INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES (?,?,'same-channel','b',1,'baseline')").run(id,source);
  const [one,two]=gitlab.subscriptions();
  const second={...healthy,id:46,iid:8,web_url:secondUrl,source_branch:'child',target_branch:healthy.source_branch};
  assert.equal(gitlab.apply(one!,await readFixture(dir,healthy)),0);
  assert.equal(gitlab.apply(two!,await readFixture(dir,second,secondUrl)),0);
  assert.equal(gitlab.apply(two!,await readFixture(dir,{...second,diverged_commits_count:3},secondUrl)),1);
  assert.equal(gitlab.apply(one!,await readFixture(dir,healthy)),0);
  const jobs=gitlab.db.prepare('SELECT subscription,event FROM events').all();
  assert.equal(jobs.length,1);assert.equal(jobs[0]!.subscription,'two');
  const event=JSON.parse(String(jobs[0]!.event));
  assert.equal(event.origin.url,secondUrl);assert.match(event.body,/MR !8 · Invented MR · merge health/);
  assert.match(event.body,/Target: fixture/);assert.match(event.body,/Behind target: 3 commit/);
});

test('pipeline fallback recovers a null or omitted head pipeline in the same GET and preserves SHA checks',async t=>{
  const dir=temp(t);
  const expected=(await readFixture(dir,healthy)).observations[1]!;
  for(const head_pipeline of [null,undefined]) {
    const commands:any[]=[];
    const result=await read(url,config,dir,async c=>{
      commands.push(c);return {stdout:JSON.stringify(c.args[1]!.includes('/discussions?')?[]:{...healthy,head_pipeline,pipeline:healthy.head_pipeline})};
    });
    assert.equal(commands.length,2); // Existing MR + discussions, no pipeline lookup.
    assert.deepEqual(result.observations[1]!.value,expected.value);
    assert.match(result.observations[1]!.body,/Pipeline: #501 success · current head/);
  }
  const older=(await readFixture(dir,{...healthy,head_pipeline:null,pipeline:{...healthy.head_pipeline,sha:'b'.repeat(40)}})).observations[1]!;
  assert.match(older.body,/different\/older head — does not validate the current head/);
  const unknown=(await readFixture(dir,{...healthy,head_pipeline:null,pipeline:{...healthy.head_pipeline,sha:null}})).observations[1]!;
  assert.match(unknown.body,/head match unknown/);assert.doesNotMatch(unknown.body,/success · current head/);
});
test('head pipeline always wins; missing and invalid fallback data never invent a successful current pipeline',async t=>{
  const dir=temp(t);
  const head={...healthy,head_pipeline:{...healthy.head_pipeline,status:'failed'}};
  const expected=(await readFixture(dir,head)).observations[1]!.value;
  for(const pipeline of [healthy.head_pipeline,{id:'malformed-but-unused'}]) {
    const result=await readFixture(dir,{...head,pipeline});
    assert.deepEqual(result.observations[1]!.value,expected);
    assert.match(result.observations[1]!.body,/Pipeline: #501 failed/);
  }
  const absent=(await readFixture(dir,{...healthy,head_pipeline:null,pipeline:null})).observations[1]!;
  assert.match(absent.body,/Pipeline: unavailable/);
  for(const pipeline of [{id:501},{...healthy.head_pipeline,web_url:'https://wrong.invalid/pipeline'}])
    await assert.rejects(readFixture(dir,{...healthy,head_pipeline:null,pipeline}));
});
test('recovering the fallback emits one health correction without reimporting notes or repeating unchanged data',async t=>{
  const dir=temp(t);init(dir,config);const gitlab=new GitLabBot(dir);t.after(()=>gitlab.close());
  gitlab.db.prepare("INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES ('s',?,'one','b',1,'baseline')").run(url);
  const sub=()=>gitlab.subscriptions()[0]!;
  assert.equal(gitlab.apply(sub(),await readFixture(dir,{...healthy,head_pipeline:null})),0);
  const fallback={...healthy,head_pipeline:null,pipeline:healthy.head_pipeline};
  assert.equal(gitlab.apply(sub(),await readFixture(dir,fallback)),1);
  assert.equal(gitlab.apply(sub(),await readFixture(dir,fallback)),0);
  assert.equal(gitlab.apply(sub(),await readFixture(dir,healthy)),0); // Same result when GitLab restores head_pipeline.
  const events=gitlab.db.prepare('SELECT event FROM events').all();
  assert.equal(events.length,1);
  const event=JSON.parse(String(events[0]!.event));assert.match(event.body,/merge health/);assert.match(event.body,/Pipeline: #501 success · current head/);
});

test('all observation kinds show the current MR title without changing their value fingerprints',async t=>{
  const dir=temp(t),data={...healthy,title:'feat(APP-123): calendar permissions',labels:['ready']};
  const snapshot=await read(url,config,dir,async c=>{
    const endpoint=c.args[1]!;
    return {stdout:JSON.stringify(endpoint.includes('/discussions?')?[{id:'d',individual_note:false,notes:[note,{...note,id:102}]}]
      :endpoint.includes('/resource_label_events?')?[{id:1,action:'add',created_at:mr.updated_at,label:{id:9,name:'ready'}}]
      :endpoint.endsWith('/approvals')?{iid:7,project_id:12,approved:true,approved_by:[{user:{id:1,username:'reviewer',name:'Reviewer'}}]}
      :data)};
  },undefined,['comment','health','metadata','label','approval']);
  assert.deepEqual(snapshot.observations.map(o=>o.key),['mr','health','note:101','note:102','label-event:1','approval']);
  for(const o of snapshot.observations) {
    assert.ok(o.body.includes('MR !7 · '+data.title),o.key);
    if(o.key!=='mr')assert.ok(!JSON.stringify(o.value).includes(data.title),'title is display-only for '+o.key);
  }
});

test('heading upgrade never replays old observations; title edits only change metadata',async t=>{
  const dir=temp(t);init(dir,config);let gitlab=new GitLabBot(dir);t.after(()=>gitlab.close());
  gitlab.db.prepare("INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES ('s',?,'legacy-channel','b',1,'baseline')").run(url);
  const sub=()=>gitlab.subscriptions()[0]!;
  const old=await readFixture(dir,healthy);
  for(const o of old.observations)o.body='Old pre-upgrade heading';
  assert.equal(gitlab.apply(sub(),old),0);gitlab.close();gitlab=new GitLabBot(dir);
  assert.equal(gitlab.apply(sub(),await readFixture(dir,healthy)),0);
  const renamed={...healthy,title:'New title'};
  assert.equal(gitlab.apply(sub(),await readFixture(dir,renamed)),1);
  const failed={...renamed,head_pipeline:{...healthy.head_pipeline,status:'failed'}};
  assert.equal(gitlab.apply(sub(),await readFixture(dir,failed)),1);
  assert.equal(gitlab.apply(sub(),await readFixture(dir,failed)),0);
  const events=gitlab.db.prepare('SELECT event FROM events ORDER BY id').all().map(e=>JSON.parse(String(e.event)));
  assert.equal(events.length,2);assert.match(events[0].body,/New title\nState:/);
  assert.match(events[1].body,/New title · merge health/);assert.match(events[1].body,/Pipeline: #501 failed/);
});
