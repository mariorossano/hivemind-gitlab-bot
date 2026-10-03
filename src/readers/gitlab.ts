import { z } from "zod/v3";
import { excerpt, type GitLabSource, type Observation, type Snapshot } from "./config.ts";
import { runCommand, type Runner } from "./process.ts";
import { WatchReader } from '../watch-reader.ts';
import { mrHeading } from '../mr-context.ts';

const authorSchema = z.object({ name: z.string(), username: z.string().optional() });
const date = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid date");
const pipelineSchema = z.object({
  id: z.number().int().positive(), status: z.string().min(1),
  sha: z.string().nullable().optional(), web_url: z.string().url().nullable().optional(),
});
const mrSchema = z.object({
  id: z.number().int(), iid: z.number().int(), project_id: z.number().int(), title: z.string(),
  state: z.enum(["opened", "closed", "merged", "locked"]), web_url: z.string().url(),
  sha: z.string().nullable().optional(), draft: z.boolean().optional(), description: z.string().nullable().optional(),
  source_branch: z.string(), target_branch: z.string(), updated_at: date, author: authorSchema,
  merge_status: z.string().nullable().optional(), detailed_merge_status: z.string().nullable().optional(),
  has_conflicts: z.boolean().nullable().optional(),
  diverged_commits_count: z.number().int().nonnegative().nullable().optional(),
  rebase_in_progress: z.boolean().nullable().optional(), head_pipeline: pipelineSchema.nullish(),
  // Validate the alternate pipeline value only when the head pipeline is absent.
  pipeline: z.unknown().optional(),
  labels: z.array(z.string()).optional(),
});
const noteSchema = z.object({
  id: z.number().int().positive(), body: z.string(), author: authorSchema, created_at: date, updated_at: date,
  system: z.boolean(), resolved: z.boolean().nullish(), resolvable: z.boolean().nullish(),
  // GitLab can omit either side of a diff or return it as null (for example for added files).
  position: z.object({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().nullable().optional(), old_line: z.number().nullable().optional() }).nullish(),
});
const discussionsSchema = z.array(z.object({ id: z.string().min(1), individual_note: z.boolean(), notes: z.array(noteSchema) }));

function sameOriginLink(value: string, hostname: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.host !== hostname || url.username || url.password) throw new Error("GitLab returned an unexpected source URL");
  return url.href;
}

function healthObservation(mr: z.infer<typeof mrSchema>, url: string, hostname: string): Observation {
  const mergeStatus = mr.detailed_merge_status ?? mr.merge_status ?? null;
  const pending = [mr.detailed_merge_status, mr.merge_status].some(status =>
    status != null && ['checking', 'unchecked', 'preparing', 'cannot_be_merged_recheck'].includes(status));
  const conflicts = mr.state !== 'opened' ? 'not_applicable'
    : pending ? 'checking'
    : mr.has_conflicts === true || mergeStatus === 'conflict' ? 'yes'
    : mr.has_conflicts === false && mergeStatus ? 'none_reported' : 'unknown';
  const selectedPipeline = mr.head_pipeline ?? (mr.pipeline == null ? null : pipelineSchema.parse(mr.pipeline));
  const pipeline = selectedPipeline ? {
    id: selectedPipeline.id, status: selectedPipeline.status, sha: selectedPipeline.sha ?? null,
    url: selectedPipeline.web_url ? sameOriginLink(selectedPipeline.web_url, hostname) : null,
    matchesHead: mr.sha && selectedPipeline.sha ? mr.sha === selectedPipeline.sha : null,
  } : null;
  const value = {
    state: mr.state, target: mr.target_branch, mergeStatus, conflicts,
    divergedCommits: mr.diverged_commits_count ?? null,
    rebaseInProgress: mr.rebase_in_progress ?? null, pipeline,
  };
  const conflictText = {
    not_applicable: 'not applicable (MR is not open)', checking: 'check pending — not yet confirmed',
    yes: 'YES', none_reported: 'none reported by GitLab', unknown: 'unknown',
  }[conflicts];
  const pipelineText = pipeline
    ? `#${pipeline.id} ${pipeline.status} · ${pipeline.matchesHead === true ? 'current head' : pipeline.matchesHead === false ? 'different/older head — does not validate the current head' : 'head match unknown'}`
    : 'unavailable / not reported';
  return {
    key: 'health', value, url, occurredAt: Date.now(),
    body: excerpt([
      `${mrHeading(mr.iid,mr.title)} · merge health (observed now)`,
      `Target: ${mr.target_branch}`,
      `Merge status: ${mergeStatus ?? 'unknown'}`,
      `Conflicts: ${conflictText}`,
      `Behind target: ${value.divergedCommits === null ? 'unknown' : value.divergedCommits + ' commit(s)'}`,
      `Pipeline: ${pipelineText}`,
      ...(pipeline?.url ? [pipeline.url] : []),
      ...(value.rebaseInProgress === true ? ['Rebase in progress'] : []),
      'Behind does not imply conflicts. These checks concern the current target, not necessarily the final main branch.',
    ].join('\n')),
  };
}

export async function readGitLab(source: GitLabSource, cwd: string, runner: Runner = runCommand, signal?: AbortSignal, events?:string[]): Promise<Snapshot> {
  const base = `projects/${encodeURIComponent(source.projectPath)}/merge_requests/${source.mr}`;
  const get = async (endpoint: string): Promise<unknown> => {
    const result = await runner({ executable: source.executable, cwd, timeoutMs: source.timeoutSeconds * 1000, signal,
      args: ["api", endpoint, "--hostname", source.hostname, "--method", "GET", "--output", "json"] });
    try { return JSON.parse(result.stdout); } catch { throw new Error("GitLab returned invalid JSON"); }
  };
  const mr = mrSchema.parse(await get(`${base}?include_diverged_commits_count=true&include_rebase_in_progress=true`));
  if(events && !mr.labels)throw new Error('GitLab omitted labels; watched MR snapshot held');
  if (mr.iid !== source.mr || new URL(mr.web_url).pathname !== `/${source.projectPath}/-/merge_requests/${source.mr}`) throw new Error("GitLab returned a different MR");
  const url = sameOriginLink(mr.web_url, source.hostname);
  const observations: Observation[] = [{ key: "mr", value: {
    title: mr.title, description: mr.description ?? "", state: mr.state, sha: mr.sha ?? null,
    draft: mr.draft ?? false, source: mr.source_branch, target: mr.target_branch, ...(mr.labels?{labels:[...mr.labels].sort()}:{}),
  }, body: excerpt(`${mrHeading(mr.iid,mr.title)}\nState: ${mr.state}${mr.draft ? " · draft" : ""}\n${mr.source_branch} → ${mr.target_branch}\nHead: ${mr.sha ?? "unavailable"}\n${mr.labels?'Labels: '+[...mr.labels].sort().join(', ')+'\n':''}\n${mr.description ?? ""}`),
    author: mr.author.name, url, occurredAt: Date.parse(mr.updated_at) }, healthObservation(mr, url, source.hostname)];
  const seenDiscussions = new Set<string>(), seenNotes = new Set<number>();
  const perPage = 100;
  let complete = false;
  for (let page = 1; page <= source.maxPages; page++) {
    const discussions = discussionsSchema.parse(await get(`${base}/discussions?per_page=${perPage}&page=${page}`));
    for (const discussion of discussions) {
      if (seenDiscussions.has(discussion.id)) throw new Error("GitLab pagination repeated a discussion; snapshot not applied");
      seenDiscussions.add(discussion.id);
      for (let index = 0; index < discussion.notes.length; index++) {
        const note = discussion.notes[index]!;
        if (seenNotes.has(note.id)) throw new Error("GitLab returned a duplicate note; snapshot not applied");
        seenNotes.add(note.id);
        if (note.system) continue; // MR state is represented above; avoid forwarding every system log line.
        const location = note.position ? `${note.position.new_path ?? note.position.old_path ?? "diff"}:${note.position.new_line ?? note.position.old_line ?? ""}` : null;
        observations.push({ key: `note:${note.id}`, value: { body: note.body, discussionId: discussion.id, ...(events?{createdAt:Date.parse(note.created_at)}:{}),
          resolved: note.resolved ?? false, resolvable: note.resolvable ?? false, position: note.position ?? null },
          body: excerpt(`${index === 0 ? "Comment" : "Reply"} on ${mrHeading(mr.iid,mr.title)}\nDiscussion ${discussion.id}${location ? ` · ${location}` : ""}${note.resolvable ? ` · ${note.resolved ? "resolved" : "unresolved"}` : ""}\n\n${note.body}`),
          author: note.author.name, url: `${url.split("#")[0]}#note_${note.id}`, occurredAt: Date.parse(note.updated_at) });
      }
    }
    if (discussions.length < perPage) { complete = true; break; }
  }
  if (!complete) throw new Error("GitLab page limit reached; no baseline or events were advanced");
  if(events?.includes('label')) {
    const reader=new WatchReader(source,cwd,runner,async()=>{},signal);
    for(const event of await reader.labelEvents(mr.project_id,mr.iid))observations.push({
      key:'label-event:'+event.id,value:event,url,occurredAt:Date.parse(event.created_at),
      body:`${mrHeading(mr.iid,mr.title)} · label ${event.action==='add'?'aggiunta':'rimossa'}: ${event.label?.name ?? '(eliminata in GitLab)'}\n${url}`,
    });
  }
  if(events?.includes('approval')) {
    const approved=z.object({iid:z.number().int(),project_id:z.number().int(),approved:z.boolean().optional(),
      approved_by:z.array(z.object({user:z.object({id:z.number().int(),username:z.string(),name:z.string()})}))}).parse(await get(base+'/approvals'));
    if(approved.iid!==mr.iid || approved.project_id!==mr.project_id)throw new Error('Approval response belongs to another MR');
    const users=approved.approved_by.map(a=>a.user).sort((a,b)=>a.id-b.id);
    observations.push({key:'approval',value:{approved:approved.approved??null,users},url,
      body:`${mrHeading(mr.iid,mr.title)} · approvazioni correnti: ${users.map(u=>'@'+u.username).join(', ') || 'nessuna'}\n`+
        `Requisiti approvazione soddisfatti secondo GitLab: ${approved.approved===undefined?'non indicato':approved.approved?'sì':'no'}.\n${url}`});
  }
  // No removal is inferred from absence: permissions and concurrently changing pages are not tombstones.
  return { observations };
}
