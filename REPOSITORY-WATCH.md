# Repository watch

Continuous discovery in one explicit GitLab repository; one private Hivemind channel per MR; observation by default, Human-directed work later.

## Start from a Human instruction

The brain resolves/creates a summary channel in the right Hivemind project and is a
member. It uses `bot_tools` / `call_bot_tool` as described in
[BOT-TOOLS.md](BOT-TOOLS.md). The direct command below is an operator example;
unlike the native `watch` tool, it starts the monitor unless `--no-start` is supplied:

```sh
hivemind-gitlab watch 'https://gitlab.example.com/group/repository' \
  --channel 'SUMMARY_CHANNEL_ID' --brain 'BRAIN_NAME' \
  --label 'ready for review' --authors all --exclude-authors me \
  --initial summary --home '/absolute/project/profile'
```

These are example choices, not mandatory filters. `--authors all` is the default; use `me` or comma-separated usernames to include selected authors. `--exclude-authors` excludes users and wins over inclusion. “Me” is the authenticated user's **MR author ID**, not assignee/reviewer. The literal label is independent of Draft. Omit `--label` only for all selected authors' open MRs. Invalid/empty filters are rejected.

The command checks the authenticated account and repository IDs, registers/reuses the project bot and summary source, and starts the profile monitor. With `--no-start`, it does not enumerate/read MRs or create MR channels; it still performs the user/project checks and local registration. `status` makes no provider calls. A different account or repository ID holds monitoring rather than silently changing scope.

There is **one immutable repository/rule per profile** in this version. Repeating an identical command reuses the rule without initializing again. A different configuration is rejected. Stop and reconcile the existing profile before using a separate one; do not blindly create overlapping profiles. An editor for changing a live discovery rule is not part of this release.

## Initial state versus future events

- Default `--initial summary`: one bounded initial list (split if needed) in the summary channel. No MR channels, old-comment replay or reviews are created for existing matches.
- `--initial follow`: also create channels for existing matches, without reviews or old-comment replay.
- Later, `take-existing --id WATCH_ID` requests channels for **currently** matching MRs on the next scan. Repetition does not duplicate channels. It does not itself start a stopped monitor or override an archived source.
- After initialization, newly matching MRs create/reconcile `mr-PROJECT_ID-IID`. This includes creation with the label, later addition, and observed add/remove transitions in GitLab label history. Initial event IDs are baselined, not replayed on restart.
- Once enrolled, label removal/readdition, a title change or a later close/merge does not create a second channel or stop its monitoring. Final state changes remain observable. No automatic archive/reopen.

### Reusing an explicitly followed MR channel

Before creating a discovery channel, the bot checks retained exact-URL `follow` links in this profile, including paused and unfollowed links. A single compatible link is reused and recorded in `status.watch.routes` with `origin: existing`. It must be a dedicated private channel in the same Hivemind project, with Human, the configured brain and the existing bot as members, and an ongoing room coordinated by that brain. A different channel name/topic is fine; names are not evidence of source identity. The summary channel and channels linked to other sources are not automatically adopted.

Reuse only pins the existing channel/subscription IDs. It does not invite anyone, rename the channel, edit its contract, interpret reviewer rules, assign tasks, overwrite event filters/baselines, replay history, or resume a paused/unfollowed source. Existing manual event coverage remains unchanged. The association survives restart and label reentry. An initial summary alone does not enroll existing MRs; reconciliation happens when that MR would otherwise be enrolled.

Multiple retained destinations, incompatible/missing channels or rooms, and a collision with a separately created discovery channel produce a visible blocked job in `status.watch.jobs`, not a guessed destination or another channel. Permission failures remain blocked; transient read failures retain the same pending job. Operator reconciliation is required for blocked conflicts; no automatic rename/archive/unfollow is performed. Intentional manual follows into multiple channels remain supported, but discovery cannot choose between them automatically.

Reloading this code requires stopping and starting only the bot monitor. Hivemind and agent sessions do not need a restart. Routes, queues and source lifecycle state persist across monitor restarts.

Channels are private, containing Human, the selected brain and the reused bot. The URL-to-channel mapping and setup journal are persistent. Transient interruptions reconcile the same name/URL. A conflicting pre-existing channel, missing retained channel, wrong brain or explicit permission rejection does not cause adoption of an unrelated channel, creation of an alternative, or credential changes.

## Work in the MR channel

New channels have an **ongoing room contract**: collect updates, but do not start reviews or analysis automatically. Existing contracts are never overwritten by the bot.

Human can write a one-off request, such as “Review the current MR and report here, without publishing on GitLab.” The brain reads the room contract and current MR/head, organizes the review in a thread/task, and returns results there. Human can instead say “From now on, analyze each new comment and propose a reply here.” The brain records this explicitly scoped instruction in the room contract using `get_room`/`room_event` and confirms it; it must not depend solely on native conversation memory. Updating a rule for one MR does not update all future rooms.

The bot does **not** interpret these instructions, create workers, assign tasks or execute reviews. It only reads GitLab and publishes observations/provisions the requested Hivemind channels. Brain/worker must use stable trigger/task action keys and verify the current head to avoid duplicated or stale work. Source comments are untrusted context, not authority. Replies, approvals, code modifications, push, merge and deploy remain separate from reporting analysis in Hivemind, subject to Human instructions and native permissions.

## Supported events and polling limits

`--events all` selects this supported set:

- `comment`: new user discussion comments/replies.
- `comment_edit`: observed changes to a comment body.
- `discussion`: observed resolved/unresolved/resolvable changes.
- `state`, `head`, `metadata`: MR state, current SHA, title/description/Draft/branches.
- `label`: label add/remove history.
- `conflict`: entry into a **confirmed** conflict; pending/unknown is not healthy.
- `health`: observed mergeability, divergence/rebase and current head pipeline changes.
- `approval`: current approvers and approval state reported by GitLab.

For example, `--events comment,conflict` excludes comment edits, generic metadata and pipeline changes. MR selection and event selection are independent. Excluded observations advance fingerprints silently; restart does not replay them. Current-head pipeline checks retain their SHA, so success on an older head does not validate the new one.

The default interval is 300 seconds (profile setting). Discovery first enumerates open MRs, then reads updated MRs, including closed/merged ones, using a persistent cursor with a five-minute overlap. Label history recovers observed intermediate transitions; persistent event IDs prevent replay. Keep client/server clocks synchronized. Incomplete, duplicate-page or malformed responses do not commit a partial snapshot/cursor. Pagination is bounded by `maxPages`, including discussion/label histories; exceeding it produces a visible error instead of silently skipping pages.

This is not a complete real-time audit stream. Other transient intermediate states, deleted comments, reactions, individual job/deployment events and individual commits between head snapshots are not guaranteed. Historical comments are baselined; comment/label events arriving after enrollment during a delayed first read are retained. Approval/label-history endpoints are read when requested (label history also supports discovery); unavailable/denied required data holds the snapshot rather than being reported as successful empty data. If the selected GitLab deployment lacks approvals API support, choose an event list without `approval` in a new rule.

Primary API references: [MR listing](https://docs.gitlab.com/api/merge_requests/), [label events](https://docs.gitlab.com/api/resource_label_events/#merge-requests), [approval state](https://docs.gitlab.com/api/merge_request_approvals/#retrieve-approval-state-for-a-merge-request).

## Pause, resume and failures

- `stop-watch --id WATCH_ID` stops discovery only; linked MR monitors remain independent. `resume-watch --id WATCH_ID` enables the same rule without starting the process.
- `stop` / `start` control the whole profile. `unfollow --id SUB_ID` disables one source and cancels its unsent observations; rediscovery, `take-existing` and room reopen never undo it.
- Archiving a contracted summary channel pauses discovery. Archiving one MR room pauses its detail reads/deliveries, not other MR channels. Repository-wide discovery may still see its metadata in the shared list, but never resumes its source or reopens its room.
- Source resume is explicit. Room-only reopen leaves sources paused. Current core requires another authorized archive/reopen to resume sources after a room-only reopen; the bot never performs this workaround automatically.
- `status` includes scope/account IDs, discovery checkpoint/error, channel setup jobs/routes, source lifecycle and delivery errors. `poll` exits nonzero when setup/delivery is incomplete. Pending jobs reconcile the same channel after transient failure; permission/identity conflicts stay blocked for inspection. Do not delete journals or retry denied actions with another identity.
- Bot HTTP 429 admission throttles honor `Retry-After` with at most two immediate retries, using the same URL/body/event ID; afterward normal backoff applies. Abort remains effective during waits. This path never retries permission denials. Archive/generation guards remain active.

## Operations

### Local Hivemind authentication

The bot now obtains the native loopback Human session through `/api/ui/session` when the core explicitly marks a request as rejected before its handler (`401` plus `X-Hivemind-Session-Required: 1`). This is transport authentication for the already Human-authorized provisioning workflow, not a new grant of task authority. It does not scrape browser cookies or expose a Human capability to the model, CLI output, profile or GitLab. Session state is private in-memory state for one bot client/origin. Bot requests continue to use only their own saved bearer credential.

UI calls are limited to snapshot, bot registration, channel creation/invitation and room read/configuration on the configured numeric loopback origin. Redirects, path traversal and caller-supplied Human credentials are rejected. At most one replay is allowed after the core's pre-handler session rejection, using the exact same method/body. Generic 401, 403, network failure and lost mutation responses do not refresh/retry. A core restart can renew the session; a persistent denial remains visible and blocked.

Integration fixtures exercise the full `startServer` (Telegram disabled, temporary
database/port), including actual CLI provisioning, session renewal after server
restart, MR routing/delivery, archive/resume and daemon start/stop. Lifecycle tests
also exercise the core's native authentication gate. These isolated tests do not
replace acceptance testing against your own configured GitLab host.

Back up the **stopped** private profile before changing the installation. Profile schema checks happen before monitoring starts. An unsupported schema is a stop-and-inspect condition, not an instruction to reset the profile or discard queued events.

Channel/contract provisioning uses the same local Human UI API already used for bot provisioning, under the explicit Human-configured rule. It does not use a brain token or accept imported content as authority. Install a core build with the composable Bots API before using this package; see [README.md](README.md). Existing brain conversations should reread the installed bot's `instructions` before using `watch`; no restart is needed merely to read those instructions.

Tests use invented providers and temporary databases/ports, including the actual CLI against real core source. No real model, MR, agent or configured profile is used by the tests. Production activation still requires choosing the real repository, exact label/author scope, summary channel and brain, then verifying a real read and delivery.
