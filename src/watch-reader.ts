import { z } from 'zod/v3';
import type { Config } from './provider.ts';
import type { Runner } from './readers/process.ts';

const id = z.number().int().positive().safe();
export const eventTypes = ['comment', 'comment_edit', 'discussion', 'state', 'head', 'metadata', 'label', 'conflict', 'health', 'approval'] as const;
const author = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+$/);
export const watchSchema = z.object({
  repository: z.string().url(), channel: z.string().min(1), brain: z.string().min(1),
  label: z.string().min(1).max(255).optional(), authors: z.array(author).min(1).default(['all']),
  excludeAuthors: z.array(author).default([]), events: z.array(z.enum(eventTypes)).min(1).default([...eventTypes]),
  initial: z.enum(['summary', 'follow']).default('summary'),
}).strict().superRefine((s, ctx) => {
  if (s.authors.includes('all') && s.authors.length > 1) ctx.addIssue({code:'custom',message:'Use all alone, or an explicit author list'});
  if (s.excludeAuthors.includes('all')) ctx.addIssue({code:'custom',message:'Exclude named authors or me, not all'});
});
export type WatchSpec = z.infer<typeof watchSchema>;
export const candidateSchema = z.object({
  id, iid: id, project_id: id, title: z.string(), web_url: z.string().url(),
  state: z.enum(['opened', 'closed', 'merged', 'locked']), labels: z.array(z.string()),
  updated_at: z.string().datetime({offset:true}), created_at: z.string().datetime({offset:true}),
  author: z.object({id, username: z.string(), name: z.string()}),
});
export type Candidate = z.infer<typeof candidateSchema>;
export const labelEventSchema = z.object({
  id, action: z.enum(['add', 'remove']), created_at: z.string().datetime({offset:true}),
  label: z.object({id, name:z.string()}).nullable(),
});
export type LabelEvent = z.infer<typeof labelEventSchema>;
export function repositoryPath(input: string, config: Config) {
  const u = new URL(input);
  if (u.protocol !== 'https:' || u.host !== config.host || u.username || u.password || u.search || u.hash)
    throw new Error('Use an exact HTTPS repository URL on the configured host');
  const p = u.pathname.replace(/^\//, '').replace(/\/$/, '');
  if (p.split('/').length < 2 || !p.split('/').every(s => /^[A-Za-z0-9_.-]+$/.test(s) && !['.', '..', '-'].includes(s)))
    throw new Error('Use the repository URL, not a group or MR URL');
  return p;
}
export class WatchReader {
  constructor(readonly config:Config, readonly cwd:string, readonly runner:Runner, readonly guard:()=>Promise<void> = async()=>{}, readonly signal?:AbortSignal) {}
  async get(endpoint:string):Promise<unknown> {
    await this.guard(); this.signal?.throwIfAborted();
    const result = await this.runner({executable:this.config.executable,cwd:this.cwd,timeoutMs:this.config.timeoutSeconds*1000,
      args:['api',endpoint,'--hostname',this.config.host,'--method','GET','--output','json'],signal:this.signal});
    return JSON.parse(result.stdout);
  }
  async identity(repository:string) {
    const p = repositoryPath(repository,this.config);
    const user = z.object({id,username:z.string()}).parse(await this.get('user'));
    const project = z.object({id,path_with_namespace:z.string(),web_url:z.string().url()})
      .parse(await this.get('projects/'+encodeURIComponent(p)));
    if (project.path_with_namespace !== p || project.web_url.replace(/\/$/,'') !== repository.replace(/\/$/,''))
      throw new Error('GitLab returned another repository; no automatic retarget');
    return {user,project};
  }
  async pages<T extends {id:number}>(endpoint:string, schema:z.ZodType<T>):Promise<T[]> {
    const all:T[] = [], seen = new Set<number>();
    for(let page=1;page<=this.config.maxPages;page++) {
      const values = z.array(schema).parse(await this.get(endpoint+(endpoint.includes('?')?'&':'?')+'per_page=100&page='+page));
      for(const value of values) {
        if(seen.has(value.id)) throw new Error('GitLab pagination repeated an item; checkpoint not advanced');
        seen.add(value.id);all.push(value);
      }
      if(values.length<100)return all;
    }
    throw new Error('GitLab page limit reached; checkpoint not advanced');
  }
  async candidates(projectId:number, repository:string, since?:number) {
    const query = new URLSearchParams({scope:'all',state:since===undefined?'opened':'all',order_by:'updated_at',sort:'asc'});
    if(since!==undefined)query.set('updated_after',new Date(Math.max(0,since-300000)).toISOString());
    const found = await this.pages(`projects/${projectId}/merge_requests?${query}`,candidateSchema);
    for(const mr of found) {
      if(mr.project_id!==projectId || mr.web_url!==`${repository}/-/merge_requests/${mr.iid}`)
        throw new Error('GitLab returned an MR outside the selected repository');
    }
    return found;
  }
  labelEvents(projectId:number,iid:number) {
    return this.pages(`projects/${projectId}/merge_requests/${iid}/resource_label_events`,labelEventSchema);
  }
}
export function authorMatches(spec:WatchSpec, mr:Candidate, accountId:number) {
  const matches = (v:string) => v==='me' ? mr.author.id===accountId : v.toLowerCase()===mr.author.username.toLowerCase();
  return (spec.authors.includes('all') || spec.authors.some(matches)) && !spec.excludeAuthors.some(matches);
}

/** Filtering does not prevent fingerprints advancing: enabling a filter never replays old changes. */
export function categories(key:string, value:any, previous:any):string[] {
  if(key.startsWith('note:')) return !previous ? ['comment'] : [
    ...(value.body!==previous.body?['comment_edit']:[]),
    ...(value.resolved!==previous.resolved || value.resolvable!==previous.resolvable?['discussion']:[]),
  ];
  if(key.startsWith('label-event:'))return ['label'];
  if(key==='approval')return ['approval'];
  if(key==='health')return ['health',...(value.conflicts==='yes' && previous?.conflicts!=='yes'?['conflict']:[])];
  if(key==='mr')return [
    ...(!previous || value.state!==previous.state?['state']:[]),
    ...(!previous || value.sha!==previous.sha?['head']:[]),
    ...(!previous || JSON.stringify(value.labels)!==JSON.stringify(previous.labels)?['label']:[]),
    ...(!previous || ['title','description','draft','source','target'].some(k=>value[k]!==previous[k])?['metadata']:[]),
  ];
  return [];
}
