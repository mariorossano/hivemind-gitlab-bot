import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { GitLabBot, init } from '../src/runtime.ts';

const source=process.env.HIVEMIND_TEST_SOURCE;
test('R02 integration: actual CLI and authenticated full server, restart, rooms, delivery, archive and daemon',
  {skip:!source,timeout:30000},async t=>{
    const {Hive}=await import(pathToFileURL(path.join(source!,'src/server/hive.ts')).href);
    const {startServer}=await import(pathToFileURL(path.join(source!,'src/server/serve.ts')).href);
    const dir=mkdtempSync(path.join(os.tmpdir(),'gitlab-r02-core-')),hive=new Hive(path.join(dir,'hive.db'));
    let core=startServer({hive,port:0,telegram:false});
    // Isolate session renewal from a pooled TCP socket racing the deliberate
    // same-port restart. Production still never retries an uncertain network failure.
    core.server.prependListener('request',(_req:any,res:any)=>res.setHeader('Connection','close'));
    let gitlab:GitLabBot|undefined;
    t.after(async()=>{gitlab?.close();await core.shutdown();hive.db.close();rmSync(dir,{recursive:true,force:true});});
    const port=await core.ready;
    const anonymous=await fetch('http://127.0.0.1:'+port+'/api/ui/snapshot');
    assert.equal(anonymous.status,401);assert.equal(anonymous.headers.get('x-hivemind-session-required'),'1');await anonymous.body?.cancel();
    const {identity,channels}=hive;
    const human=identity.getAgent('human');
    const project=hive.projects.createProject(human,{name:'GitLab fixture',slug:'gitlab-fixture'});
    const brain=identity.join({role:'brain',project:project.slug}).agent;
    const summary=channels.createChannel(brain,{name:'fixture-review-inbox',type:'private'});
    const repo='https://gitlab.example.invalid/group/repo',data=path.join(dir,'fixture.json'),calls=path.join(dir,'calls.log');
    const executable=path.join(dir,'glab-fixture');
    writeFileSync(data,JSON.stringify({mrs:[],notes:[]}),{mode:0o600});writeFileSync(calls,'',{mode:0o600});
    writeFileSync(executable,`#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2);if(args[0]!=='api'||args[args.indexOf('--method')+1]!=='GET'||args[args.indexOf('--hostname')+1]!=='gitlab.example.invalid')process.exit(31);
const endpoint=args[1];fs.appendFileSync(${JSON.stringify(calls)},endpoint+'\\n');
const d=JSON.parse(fs.readFileSync(${JSON.stringify(data)},'utf8'));
const u=new URL('https://gitlab.example.invalid/'+endpoint),p=decodeURIComponent(u.pathname);let result;
if(p==='/user')result={id:7,username:'fixture-operator'};
else if(p==='/projects/group/repo')result={id:42,path_with_namespace:'group/repo',web_url:${JSON.stringify(repo)}};
else if(p==='/projects/42/merge_requests')result=d.mrs;
else if(p.endsWith('/discussions'))result=d.notes.map(n=>({id:'discussion-'+n.id,individual_note:false,notes:[n]}));
else if(p.endsWith('/resource_label_events'))result=[];
else if(p.endsWith('/approvals'))result={iid:1,project_id:42,approved:false,approved_by:[]};
else if(p.includes('/merge_requests/'))result=d.mrs.find(m=>m.iid===Number(p.split('/').at(-1)));else process.exit(32);
process.stdout.write(JSON.stringify(result));
`,{mode:0o700});
    const home=path.join(dir,'gitlab');init(home,{hiveUrl:'http://127.0.0.1:'+port,host:'gitlab.example.invalid',executable});
    const cli=async(args:string[])=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('../bin/hivemind-gitlab.mjs',import.meta.url)),'--home',home,...args],{stdio:['ignore','pipe','pipe']});
      let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
      const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
      try {const [code]=await once(child,'close');assert.equal(code,0,err+'\n'+out);return JSON.parse(out);}
      finally{clearTimeout(timer);}
    };
    const registered=await cli(['watch',repo,'--channel',summary.id,'--brain',brain.name,'--label','ready for review','--exclude-authors','me','--no-start']);
    assert.equal(registered.monitorRunning,false);assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,2);
    await cli(['status']);assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,2);
    assert.equal((await cli(['stop-watch','--id',registered.id])).discoveryEnabled,false);
    const bot=identity.listAgents(human).find((agent:any)=>agent.role==='bot')!;
    assert.equal(hive.rooms.botLinks(bot,summary.id)[0]!.observed,'failed');
    assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,2);
    assert.equal((await cli(['resume-watch','--id',registered.id])).monitorStarted,false);
    gitlab=new GitLabBot(home);await gitlab.request('/api/ui/snapshot');
    await core.shutdown();core=startServer({hive,port,telegram:false});await core.ready;
    // Same gitlab object, same port, new process-lifetime Human capability.
    await gitlab.request('/api/ui/snapshot');assert.equal(gitlab.watch.current()!.initialized,0);
    await cli(['poll']);assert.equal(gitlab.watch.current()!.initialized,1);
    const fakeMR={id:101,iid:1,project_id:42,title:'Synthetic review',web_url:repo+'/-/merge_requests/1',state:'opened',labels:['ready for review'],
      author:{id:8,username:'fixture-author',name:'Fixture author'},created_at:new Date().toISOString(),updated_at:new Date().toISOString(),
      source_branch:'fixture-branch',target_branch:'main',sha:'a'.repeat(40),draft:false,has_conflicts:false,detailed_merge_status:'mergeable'};
    writeFileSync(data,JSON.stringify({mrs:[fakeMR],notes:[]}));await cli(['poll']);
    const route=gitlab.db.prepare('SELECT * FROM mr_routes').get()!;assert.ok(route.channel);
    const channel=channels.getChannel(String(route.channel));assert.equal(channel.type,'private');assert.ok(channel.memberIds.includes(brain.id));
    let room=hive.rooms.view(human,channel.id).room;assert.equal(room.contract.mode,'ongoing');assert.equal(room.coordinatorId,brain.id);
    assert.equal(hive.db.prepare('SELECT COUNT(*) n FROM task_records').get().n,0);
    const contract={...room.contract,rules:['Human: analyze future comments, report only here; do not publish.']};
    hive.rooms.event(human,channel.id,{requestId:'fixture-set-rule',expectedRevision:room.revision,action:{type:'configure',contract,reason:'Synthetic Human instruction'}});
    const newNote={id:9,body:'Fixture new comment',author:{name:'Fixture author'},system:false,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    writeFileSync(data,JSON.stringify({mrs:[fakeMR],notes:[newNote]}));await cli(['poll']);
    room=hive.rooms.view(human,channel.id).room;assert.deepEqual(room.contract.rules,contract.rules);
    assert.equal(hive.db.prepare("SELECT COUNT(*) n FROM messages WHERE channel_id=? AND body LIKE '%Fixture new comment%'").get(channel.id).n,1);
    const count=hive.db.prepare('SELECT COUNT(*) n FROM bot_events').get().n;await cli(['poll']);assert.equal(hive.db.prepare('SELECT COUNT(*) n FROM bot_events').get().n,count);
    hive.rooms.event(human,channel.id,{requestId:'fixture-archive',expectedRevision:room.revision,action:{type:'archive',reason:'Pause this MR'}});
    writeFileSync(calls,'');await cli(['poll']);assert.ok(!readFileSync(calls,'utf8').includes('/merge_requests/1'));
    room=hive.rooms.view(human,channel.id).room;
    hive.rooms.event(human,channel.id,{requestId:'fixture-reopen',expectedRevision:room.revision,action:{type:'reopen',resumeSources:true,reason:'Resume this MR'}});
    await cli(['poll']);assert.ok(readFileSync(calls,'utf8').includes('/merge_requests/1'));
    assert.equal(gitlab.watch.status()!.routes.length,1);assert.equal(gitlab.isRunning(),false);
    assert.equal((await cli(['start'])).monitorRunning,true);
    assert.equal((await cli(['status'])).monitorRunning,true);
    assert.equal((await cli(['stop'])).monitorRunning,false);
    assert.equal(hive.db.prepare('SELECT COUNT(*) n FROM task_records').get().n,0);

    // Real core: manual follow + a later discovery match must preserve the same
    // channel, room and source link, even when Human archived it before discovery.
    const manualMR={...fakeMR,id:102,iid:2,web_url:repo+'/-/merge_requests/2',labels:[] as string[]};
    writeFileSync(data,JSON.stringify({mrs:[fakeMR,manualMR],notes:[]}));await cli(['poll']);
    const manual=channels.createChannel(brain,{name:'human-selected-review-room',type:'private',topic:'Custom title; not a generated discovery topic'});
    hive.rooms.event(human,manual.id,{requestId:'manual-contract',expectedRevision:0,
      action:{type:'configure',contract:{...contract,rules:['The selected reviewer keeps this assignment. No automatic reviews.']},reason:'Human selected this MR channel'}});
    const followed=await cli(['follow',manualMR.web_url+'#note_2','--channel',manual.id,'--no-start']);await cli(['poll']);
    let manualRoom=hive.rooms.view(human,manual.id).room;
    hive.rooms.event(human,manual.id,{requestId:'archive-manual',expectedRevision:manualRoom.revision,action:{type:'archive',reason:'Human pauses this MR'}});
    manualRoom=hive.rooms.view(human,manual.id).room;
    const storedContract=JSON.stringify(manualRoom),storedChannel=JSON.stringify(channels.getChannel(manual.id));
    // The core may append its normal pause acknowledgement, not a new MR observation.
    const observationCount=()=>hive.db.prepare("SELECT COUNT(*) n FROM messages WHERE channel_id=? AND body NOT LIKE 'Source lifecycle report%'").get(manual.id).n;
    const historyBefore=observationCount();
    manualMR.labels=['ready for review'];writeFileSync(data,JSON.stringify({mrs:[fakeMR,manualMR],notes:[]}));writeFileSync(calls,'');
    await cli(['poll']);
    const reused=gitlab.watch.status()!.routes.find(r=>r.url===manualMR.web_url)!;
    assert.equal(reused.channel,manual.id);assert.equal(reused.subscription,followed.id);assert.equal(reused.origin,'existing');
    assert.equal(hive.db.prepare("SELECT COUNT(*) n FROM channels WHERE name='mr-42-2'").get().n,0);
    assert.equal(JSON.stringify(channels.getChannel(manual.id)),storedChannel);
    assert.equal(JSON.stringify(hive.rooms.view(human,manual.id).room),storedContract);
    assert.equal(observationCount(),historyBefore);
    assert.equal(gitlab.lifecycle.state(followed.id)!.applied,'paused');
    assert.ok(!readFileSync(calls,'utf8').includes('/merge_requests/2?'));
    assert.equal(gitlab.subscriptions().find(s=>s.id===followed.id)!.event_filter,null);
    assert.equal(hive.db.prepare('SELECT COUNT(*) n FROM task_records').get().n,0);
    hive.rooms.event(human,manual.id,{requestId:'resume-manual',expectedRevision:manualRoom.revision,action:{type:'reopen',resumeSources:true,reason:'Human resumes the same MR'}});
    const freshNote={...newNote,id:10,body:'Update after explicit manual-room resume'};
    writeFileSync(data,JSON.stringify({mrs:[fakeMR,manualMR],notes:[freshNote]}));await cli(['poll']);
    assert.equal(hive.db.prepare("SELECT COUNT(*) n FROM messages WHERE channel_id=? AND body LIKE '%Update after explicit manual-room resume%'").get(manual.id).n,1);
    await cli(['poll']);assert.equal(hive.db.prepare("SELECT COUNT(*) n FROM messages WHERE channel_id=? AND body LIKE '%Update after explicit manual-room resume%'").get(manual.id).n,1);
    assert.equal(gitlab.watch.status()!.routes.length,2);
  });
