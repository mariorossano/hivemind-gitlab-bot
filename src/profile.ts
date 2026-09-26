import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod/v3';
import {configSchema,profileIdentity,definitionId} from './provider.ts';

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bindingSchema=z.object({version:z.literal(1),definitionId:z.string(),projectId:z.string().regex(/^[A-Za-z0-9_-]+$/),hiveUrl:z.string()}).strict();
function write(file:string,value:unknown){const tmp=file+'.'+randomUUID()+'.next';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,file);}
export function projectBinding(home:string) {
  try {const b=bindingSchema.parse(JSON.parse(readFileSync(path.join(home,'hivemind-project.json'),'utf8')));if(b.definitionId!==definitionId)throw new Error('Profile belongs to another bot');return b;}
  catch(e:any){if(e.code==='ENOENT')return undefined;throw e;}
}
export function assertProject(home:string,projectId:string,hiveUrl:string) {
  const b=projectBinding(home);
  if(b&&(b.projectId!==projectId||b.hiveUrl!==hiveUrl))throw new Error('This bot profile belongs to another Hivemind project or server');
}
export function configureProfile(home:string,raw:unknown) {
  const input=z.object({config:z.unknown(),projectId:z.string().regex(/^[A-Za-z0-9_-]+$/)}).strict().parse(raw);
  const config=configSchema.parse(input.config),url=new URL(config.hiveUrl);
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Use a numeric-loopback Hivemind origin');
  config.hiveUrl=url.origin;
  mkdirSync(home,{recursive:true,mode:0o700});chmodSync(home,0o700);
  const setup=new DatabaseSync(path.join(home,'setup.lock.db'));chmodSync(path.join(home,'setup.lock.db'),0o600);
  let monitor:DatabaseSync|undefined;
  try {
    setup.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    assertProject(home,input.projectId,config.hiveUrl);
    const file=path.join(home,'config.json');
    const old=existsSync(file)?configSchema.parse(JSON.parse(readFileSync(file,'utf8'))):undefined;
    const changed=!old||hash(old)!==hash(config);
    monitor=new DatabaseSync(path.join(home,'monitor.lock.db'));chmodSync(path.join(home,'monitor.lock.db'),0o600);
    let running=false;
    try {monitor.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}
    catch(e:any){if(e.errcode!==5&&!String(e.message).includes('database is locked'))throw e;running=true;}
    if(running&&changed)throw new Error('Stop this profile monitor before changing its settings');
    const state=path.join(home,'state.db');
    if(existsSync(state)) {
      const db=new DatabaseSync(state,{readOnly:true});
      try {
        const saved=db.prepare('SELECT value FROM meta WHERE key=?').get('identity') as any;
        if(saved&&saved.value!==hash(profileIdentity(config)))throw new Error('Settings change the identity of a retained source profile; use a new profile');
        if(db.prepare('SELECT 1 FROM bots WHERE project<>? LIMIT 1').get(input.projectId))throw new Error('Existing profile contains bots from a different project');
      } finally {db.close();}
    }
    if(changed)write(file,config);
    write(path.join(home,'hivemind-project.json'),{version:1,definitionId,projectId:input.projectId,hiveUrl:config.hiveUrl});
    return {configured:true,projectId:input.projectId,monitorRunning:running};
  } finally {monitor?.close();setup.close();}
}
