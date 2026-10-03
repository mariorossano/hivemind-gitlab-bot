/** Display text is source context, never source identity or an instruction. */
export function mrTitle(title: string, limit = 240): string {
  const text = title.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim() || 'Untitled merge request';
  return text.length <= limit ? text : text.slice(0, limit - 1).trimEnd() + '…';
}

export function mrHeading(iid: number, title: string): string {
  return `MR !${iid} · ${mrTitle(title)}`;
}

/** Pin this name at enrollment. A later title edit must not rename or reroute it. */
export function mrChannelName(project: number, iid: number, title: string): string {
  const subject = mrTitle(title, 4000)
    .replace(/^(?:(?:draft|wip)\s*:\s*|\[(?:draft|wip)\]\s*)+/i, '')
    .replace(/^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]*\))?!?\s*:\s*/i, '')
    .replace(/^(?:\[[a-z][a-z0-9]*-\d+\]|[a-z][a-z0-9]*-\d+)\s*[:\-]?\s+/i, '')
    .replace(/^\[(?:ios|android|web)\]\s*/i, '');
  const prefix = `mr-${iid}-`, suffix = `-p${project}`;
  const slug = subject.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'merge-request';
  // Keep the project discriminator at the end, leaving useful words visible first.
  return prefix + slug.slice(0, 100 - prefix.length - suffix.length).replace(/-+$/g, '') + suffix;
}
