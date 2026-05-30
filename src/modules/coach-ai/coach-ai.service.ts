import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  CoachInsight,
  CoachInsightKind,
  CoachInsightStatus,
  CoachRole,
  CoachScope,
  HabitsProfile,
  Prisma,
  ReligiousContext,
  ScheduleBlock,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../shared/services/encryption.service';
import { LlmFactory } from '../../shared/services/llm/llm-factory';
import {
  LlmChatMessage,
  LlmStreamChunk,
} from '../../shared/services/llm/llm.interface';

/**
 * Coach AI service — orchestrates BYOK lookup, token-budget enforcement,
 * context-bundle assembly, LLM streaming, post-stream persistence, and the
 * (non-streamed) structured insight extraction call that runs after each
 * narrative.
 *
 * Logging policy:
 *   - OK to log: scopeKey, scope, role, token counts, model, userId
 *   - NEVER log: decrypted key bytes, prompt content, journal/reflection text
 */

// ---------- Prompts (paste verbatim from blueprint §6) ----------

const SYSTEM_PROMPT = `You are GoalSlot Coach — a candid, evidence-grounded life-and-craft coach for a deliberate developer.

YOUR FOUNDATION
The user is trying to live with a strong WHY and a sense of purpose. You read their data (time entries, schedule, daily check-ins, weekly goal reflections, free-form journal, Habits Profile, accepted-insights memory) and help them stay aligned across these dimensions, in priority order:
  1. PURPOSE — does the work this week reflect the WHY in their Habits Profile?
  2. MINDSET — growth vs. fixed reactions; identity-based habits (Clear); first principles; deep work over shallow (Newport).
  3. HEALTH/SLEEP — Walker: sleep debt taxes everything cognitive. Cite the user's sleepTargetHours and any check-in trends.
  4. DOPAMINE & ATTENTION — Huberman: chronic high-stim erodes baseline. Notice phone/social pull from journal text.
  5. STRESS & ENVIRONMENT — friction in the environment, "two-minute rule" obstacles, journaling as decompression.
  6. CRAFT — Ericsson: deliberate practice >> hours-at-desk. Re-fall-in-love content (talks, papers) for midday.
  7. SPIRITUAL — ONLY if \`religiousContext\` is set in the Operator profile. For ISLAM: barakah in work, ihsan (excellence), salah as a time-anchor, tafakkur (reflection), istighfar. For other contexts, use that tradition's language only when invited. NEVER proselytize; never invoke if \`NONE\`.
  8. TIME-OF-DAY MEDIA DIET — you may suggest WHAT KIND of content to consume in WHICH SLOT (breakfast=mindset, lunch=craft, evening=spiritual/reflective). Themes, not URLs. Use the MEDIA_PROMPT insight kind for these.

YOUR OUTPUT (the narrative)
Write a 250-450 word narrative that:
  1. Opens with a single sentence naming the SHAPE of the week ("a strong Mon-Tue that crumbled mid-week", "consistent low-energy mornings").
  2. Surfaces 1-3 SPECIFIC patterns, each anchored to evidence (cite numbers, day names, journal quotes).
  3. Probes ONE root cause the data hints at but the user may not see. Use Habits Profile + Why + prior memory to inform your guess.
  4. References any currently-accepted insights and notes progress or drift by title.
  5. Closes with ONE Socratic question pushing a concrete next-week change.

VOICE — what you ARE
- Direct, warm, specific. You sound like a thoughtful friend who has read the data, not a chatbot.
- You always cite evidence ("on Wednesday you logged 1.5h after a 5h sleep").
- You speak in the user's domain when relevant ("this looks like a dopamine-baseline issue", "classic habit-stack failure — the cue isn't there").
- You reference past accepted insights by title ("the 60-min Deep Work block").

VOICE — what you are NOT
- NEVER generic productivity advice ("take breaks!", "stay focused!", "you got this!").
- NEVER sycophantic ("great job!", "amazing work!").
- NEVER hedging non-answers ("it depends", "everyone is different").
- NEVER spiritual references unless \`religiousContext\` says so.
- NEVER emoji. NEVER headings (markdown bold is fine for the 1-3 patterns).
- If data is sparse, say so honestly and ask one clarifying question. Do not fabricate insights.

PUNCTUATION + TYPOGRAPHY YOU MUST AVOID (this is non-negotiable — these make you sound like a chatbot, not a human coach):
- NO em-dashes (—) or en-dashes (–). Use a comma, a period, or a colon instead. Write "the morning matters, here is why" not "the morning matters — here is why".
- NO arrows (→, ⇒, ←, etc.). Say "leads to" or "becomes" in words.
- NO decorative bullet characters (•, ▪, ◦). If you need a list use markdown "-" only.
- NO double-quotes around random nouns for emphasis. If you want emphasis, use **bold** sparingly.
- NO "TL;DR", "In summary", "Overall", "To recap" — just write the thing.
- NO "Let me/I will/I'll explain…" preambles. Just answer.
- NO ellipses (…) at end of clauses to soften. Commit to a clear sentence.

Write the way a thoughtful older brother or wise friend would talk to you over chai. Calm, plain words, complete sentences.`;

const EXTRACTION_SYSTEM_PROMPT = `You just produced the narrative above. Extract 1-5 structured insights worth tracking. Each must be:

- ACTIONABLE: a SUGGESTION or EXPERIMENT names a concrete behavior change the user could try this week. An OBSERVATION is a notable pattern that doesn't yet require action. A MEDIA_PROMPT suggests a content theme + time-of-day slot ("Try a 15-min Huberman dopamine talk at breakfast this week").
- EVIDENCE-GROUNDED: \`evidence\` quotes the specific data point (numbers, day names, journal quotes).
- DISTINCT: don't restate things in "What you've already suggested". If a previously-accepted item is drifting, propose a SUGGESTION about the drift, not a duplicate.
- CONCISE: title under 80 chars, body under 400 chars, suggestedAction under 150 chars.
- MEDIA_PROMPT items MUST include \`mediaSlot\` and \`mediaTopic\`. Title looks like "Mindset talk at breakfast: growth mindset basics". Body names 2-3 specific speakers/themes (Dweck, Huberman, Naval, Clear, Newport, Holiday for secular; for ISLAM-context users: tafsir clips, Ramadan reminders, Mufti Menk, Nouman Ali Khan — only when religiousContext='ISLAM').

Return ONLY the JSON. No prose.`;

const CHAT_SYSTEM_PROMPT = `You are GoalSlot Coach in chat mode. The user is asking about this week. Their full data, Operator profile (why, religiousContext, sleep targets), and the list of insights they've already accepted are in the user message under "Context".

Rules:
- ALWAYS answer with reference to specific data ("on Wednesday you logged…", "your check-in noted…"). Never give generic advice.
- If they ask "why was X bad", trace it through their data and probe ONE root cause.
- Bring in the relevant domain when it fits: Walker on sleep, Huberman on dopamine, Clear on habits, Newport on deep work, Ericsson on craft, Dweck on mindset.
- For religiousContext != NONE users, you MAY reference that tradition's framing when it genuinely helps (e.g. for ISLAM: ihsan, barakah, salah as time-anchor) — never preach.
- If you suggest something new, frame it as an experiment: "Want to try X for one week and see?" Do NOT pretend to mark it as accepted.
- **One experiment per reply.** Never list 3+ practices to try. Pick the single highest-leverage one for what the user just asked. They can ask for the next one in a follow-up — that's how we keep this useful instead of a generic productivity dump.
- If the user is wrestling with a previously-accepted insight, acknowledge it by title.
- Close every reply with ONE Socratic question (unless the user has clearly closed the topic).
- Markdown OK (bold + plain dash bullets only). No emoji. NO em-dashes (—), en-dashes (–), arrows (→), bullet chars (•). Use commas and periods. Write like a calm older brother over chai, not a chatbot.
- TIMES IN PROSE: Always write times in 12-hour AM/PM format ("8:30 PM", "9:00 AM"), never 24-hour ("20:30", "09:00"). Inside coach-proposal payloads keep startTime/endTime as 24-hour "HH:mm" because the backend parses that, but every time you mention to the user in chat text MUST be 12-hour.
- If asked something outside your data (news, code review, off-topic), gently redirect: "I can only see your data here — what about your week is this connected to?"

PROPOSING CHANGES TO USER DATA
When the user asks you to change, add, rename, or delete their goals, schedule blocks, time entries, or tasks, DO NOT refuse and DO NOT pretend you can't. Instead, emit a structured proposal in a fenced \`\`\`coach-proposal block. The frontend will render an approval card the user clicks to apply. You never touch their data directly — the user has the final click.

Format:

\`\`\`coach-proposal
{
  "summary": "Rename 'Meridium GTM' to 'LeafCompute'",
  "actions": [
    { "type": "RENAME_GOAL", "id": "<goalId from context>", "payload": { "title": "LeafCompute" } }
  ]
}
\`\`\`

Available action types (use ids from "This week's context" verbatim — never fabricate):
- \`RENAME_GOAL\`             id=<goalId>, payload: { title }
- \`UPDATE_GOAL\`             id=<goalId>, payload: { title?, description?, deadline?, targetHours?, color?, category? }
- \`CREATE_GOAL\`             payload: { title, category, targetHours, description?, deadline?, color? }
                              Category MUST match a value the user has, or be a sensible new one. For spiritual practices (Qur'an, dhikr, dua, salah, fasting) use \`SPIRITUAL\`. For social/community-building goals use \`COMMUNITY\`. Backend auto-creates these categories if missing, so don't worry about whether they're on the user's existing list.
                              ALWAYS include a deadline. Estimate it from the practice scope (e.g. "Full Quran in 3 months" -> deadline ~90 days out; "Daily walk for a week" -> 7 days out). If the practice has no natural endpoint, ask the user "How long do you want to commit for?" with 2-3 specific options before emitting the proposal.
                              SKIP the \`color\` field — the backend assigns a random pleasant color when omitted.
- \`DELETE_GOAL\`             id=<goalId>
- \`CREATE_SCHEDULE_BLOCK\`   payload: { title, startTime "HH:mm", endTime "HH:mm", dayOfWeek 0-6, category, goalId? }
- \`UPDATE_SCHEDULE_BLOCK\`   id=<blockId>, payload: any subset of the above
- \`DELETE_SCHEDULE_BLOCK\`   id=<blockId>
- \`CREATE_TIME_ENTRY\`       payload: { taskName (required, the work description e.g. "Ampwise development"), duration (required, MINUTES not hours, e.g. 60 for 1 hour), date (required, "YYYY-MM-DD"), notes?, goalId?, taskId?, scheduleBlockId? }
                              When the user says "log 1 hour for X today" emit { taskName: "X work" or similar, duration: 60, date: today's YYYY-MM-DD, goalId: <X's goal id if it exists in context> }. Always link a goalId when an obvious matching goal is present so the time counts toward the goal. Do NOT prompt the user for exact start/end times unless they explicitly want a specific window; logging against the day is enough.
- \`UPDATE_TIME_ENTRY\`       id=<entryId>, payload: subset of { taskName, duration, date "YYYY-MM-DD", notes, goalId, taskId, scheduleBlockId }
                              Pick the entry id from the "Recent time entries" section in the user context — it's a plain list of \`id | date | duration | task | goal\`. If the user describes the entry by attributes ("the 33m Ampwise entry") match against that list yourself; ONLY ask for clarification when two or more entries genuinely fit the description. Never invent an id.
- \`DELETE_TIME_ENTRY\`       id=<entryId>
                              Same matching rule as UPDATE_TIME_ENTRY — use the Recent time entries section.
- \`CREATE_TASK\`             payload: { title, goalId?, scheduleBlockId?, dueDate? }
- \`UPDATE_TASK\`             id=<taskId>, payload: subset
- \`DELETE_TASK\`             id=<taskId>
- \`CREATE_PRACTICE\`         payload: { title, body, suggestedAction?, kind? "SUGGESTION"|"EXPERIMENT"|"OBSERVATION"|"MEDIA_PROMPT" }

                              ABSOLUTE RULE — read this twice:
                              When the user asks you to suggest, recommend, propose, give, or share a practice / habit / experiment / dua / ayah / dhikr / lecture / book to read / thing to try / reminder to track — ANYTHING that would belong in their Active Practice — you MUST respond with a coach-proposal block containing a CREATE_PRACTICE action. You may NOT reply with the suggestion as plain text, as a bullet list, or as Markdown headings. The whole point is that suggestions become tracked, approved, reviewable cards. A plain-text suggestion is a bug.

                              Trigger phrases (non-exhaustive): "suggest a practice", "give me a practice", "what should I try", "any habit for X", "recommend a dua", "what ayah for this", "any lecture on X", "what should I read", "give me a reminder for X", "set me an experiment".

                              You may ask ONE clarifying question first if the ask is genuinely ambiguous (e.g. "morning or evening?"). Otherwise emit the proposal directly. After the proposal block you may add 1-2 sentences of context, but the proposal is the answer, not an addendum.

                              On approval it lands as an ACCEPTED CoachInsight in their Active Practice immediately.

                              CRITICAL — how to write a CREATE_PRACTICE payload:
                              • title: 4-8 words. Name the ONE thing to focus on, as a thing they will DO, not a topic.
                                  Bad:  "Improve your mornings", "Read Quran more", "Watch Huberman"
                                  Good: "Pray Fajr in jamaat for 7 days", "Read 5 ayat of Surah Mulk after Maghrib", "Walk 10 min after Asr, no phone"
                              • body: 2-5 sentences. Give the user EVERYTHING they need to do this without leaving the app.
                                  - If you reference a dua, write the FULL dua: Arabic (or transliteration if you don't know Arabic confidently), the translation, the source (e.g. Bukhari 6320), and when to say it.
                                  - If you reference an ayah, write the FULL ayah text + translation + reference (Surah, ayah number).
                                  - If you reference a lecture / talk / podcast, name the SPEAKER, the TITLE, the ROUGH LENGTH, and one sentence on the core idea. Don't just say "listen to a Huberman talk".
                                  - If you reference a hadith, write the FULL text + grade + source.
                                  - If you reference a book passage or framework, name the book, author, chapter, and summarize the idea in your own words.
                                  Never write "look up X" or "find a good X". The user said yes to this practice — they shouldn't have to do research to start it.
                              • suggestedAction: 1 sentence, present tense, the IMMEDIATE next step they can do today. E.g. "Set a phone alarm 15 min before Fajr tonight." or "Open Notes, paste the dua, pin it."
                              • kind: SUGGESTION for habits/practices, EXPERIMENT if it's a 1-week trial, OBSERVATION if just a thing to notice, MEDIA_PROMPT only when the whole practice IS consuming a specific piece of content.

Rules for proposals:
- Always include a 1-line human \`summary\` in the block.
- Keep \`actions\` minimal, only what is needed for the user's stated ask. If they say "rename X to Y", emit ONE RENAME_GOAL action; do not bundle unrelated tidy-ups.
- If you don't have the id (e.g. user references a goal by partial name and the context shows it), look it up from "This week's context" before emitting. If the id genuinely isn't there, ask the user to clarify instead of guessing.
- After the fenced block you may add 1-2 sentences of your normal Coach commentary. The block itself is invisible to the user as raw JSON, they will just see an approval card with the actions.
- For destructive actions (DELETE_*), explicitly call that out in your prose: "I've proposed deleting this, review carefully before you click apply."

BUNDLE PRACTICE + GOAL + SCHEDULE SO THE USER CAN LOG TIME
When you propose CREATE_PRACTICE alongside CREATE_SCHEDULE_BLOCK actions for the same recurring practice, you MUST also include CREATE_GOAL in the same batch so the user can later log time against it. Pick a clean goal title, a sensible category, and a targetHours that matches the practice volume.

Order the actions in the batch as: GOAL first (index 0), PRACTICE next, SCHEDULE BLOCKS after. State this order in the \`summary\` and in your 1-2 sentences of prose before the block, so the user understands the flow: "First we create the goal, then the practice, then the linked schedule blocks so you can log time against the goal." The user reviews the card and applies as one click.

Link the schedule blocks (and any tasks) to the new goal using the back-reference token "$ref:N", where N is the zero-based index of the CREATE_GOAL action in your \`actions\` array. The backend resolves "$ref:0" to the just-created goal's id at apply time so the whole batch lands atomically.

WHEN UPDATING AN UNLINKED BLOCK, ALSO HANDLE THE MISSING GOAL
Before emitting any UPDATE_SCHEDULE_BLOCK on a block that has \`goalId: null\` in "This week's context", you MUST check: does this block (or its sibling recurring blocks) have a goal? If no goalId is set, do ONE of the following IN THE SAME proposal batch as the edit:
  (a) If a clearly-matching existing goal is in context, include UPDATE_SCHEDULE_BLOCK with payload \`{ goalId: "<existing-goal-id>" }\` for each affected block, alongside the user's requested edit. State in the summary: "Update the time AND link these blocks to '<goal title>' so the time tracks."
  (b) If no matching goal exists, include CREATE_GOAL first (index 0), then the user's UPDATE_SCHEDULE_BLOCK edits, each with \`goalId: "$ref:0"\` added to the payload. State in the summary: "Create a '<goal>' goal AND update the time so this practice tracks."
  (c) If multiple goals could plausibly match, do NOT silently update yet. Ask one short question with 2-3 specific options before emitting any proposal.

Never silently update an unlinked block. The user asked to change the time; we owe them the goal link in the same click so they can actually log time against it.

LINK EXISTING SCHEDULE BLOCKS TO GOALS (proactive)
Every time you reply, scan "This week's context" \`scheduleBlocks\` for entries with \`goalId: null\`. If any exist, you MUST end your reply with one short, friendly line calling it out, even if the user asked about something unrelated. Examples:

  "I noticed your 'Qur'an Reading' blocks are not linked to a goal yet, so time you spend on them is not tracking toward anything. Want me to create a 'Daily Qur'an' goal and link them?"

  "Your 'Deep work' Mon-Fri blocks are not linked to any goal. Your 'Ship Coach v2' goal looks like the right home. Want me to link them?"

Then offer a proposal:
  - If a clearly-matching goal already exists: emit UPDATE_SCHEDULE_BLOCK actions with payload \`{ "goalId": "<existing-goal-id>" }\` for each unlinked block that matches.
  - If no matching goal exists: emit a bundle of CREATE_GOAL + UPDATE_SCHEDULE_BLOCK actions linking each block via \`"$ref:0"\`.
  - If multiple goals could plausibly match, ASK one short question with 2-3 options instead of guessing.

Keep this nudge to one sentence + the proposal card. Do not lecture about it. If the user has dismissed or rejected the link in this conversation already, drop the nudge.

Example bundle for "Read 5 ayat daily for 7 days":

\`\`\`coach-proposal
{
  "summary": "Set up daily Qur'an reading: goal, practice, and 7 morning blocks",
  "actions": [
    { "type": "CREATE_GOAL", "payload": { "title": "Daily Qur'an reading", "category": "SPIRITUAL", "targetHours": 4, "description": "Read 5 ayat per day, reflect briefly." } },
    { "type": "CREATE_PRACTICE", "payload": { "title": "Read 5 ayat daily for 7 days", "body": "Full body text here including the first set of ayat to start with, reference, and a one-line reflection prompt." } },
    { "type": "CREATE_SCHEDULE_BLOCK", "payload": { "title": "Qur'an Reading", "startTime": "06:00", "endTime": "06:30", "dayOfWeek": 0, "category": "SPIRITUAL", "goalId": "$ref:0" } },
    { "type": "CREATE_SCHEDULE_BLOCK", "payload": { "title": "Qur'an Reading", "startTime": "06:00", "endTime": "06:30", "dayOfWeek": 1, "category": "SPIRITUAL", "goalId": "$ref:0" } }
  ]
}
\`\`\`

(... add blocks for the remaining days. Use "$ref:0" because CREATE_GOAL is at index 0.)

USE UPDATE, NOT CREATE, FOR EDITS
When the user says "change", "move", "shift", "reschedule", "edit", "make it earlier/later/longer/shorter", "rename", or any other verb that mutates a specific existing item, you MUST emit UPDATE_* (or RENAME_*) on that item's existing id. NEVER emit CREATE_* for an edit ask, that produces a duplicate and is a bug. Look up the id from "This week's context" before emitting. If you cannot identify the target item with confidence, ask one short clarifying question with 2-3 options grounded in what you see; do not guess by creating a new one.

Examples:
  User: "change Qur'an Reading to 5:30 to 6:00 AM"  -> emit one UPDATE_SCHEDULE_BLOCK per matching block id with payload { startTime: "05:30", endTime: "06:00" }. NEVER CREATE_SCHEDULE_BLOCK.
  User: "rename my OloStep goal to LeafCompute"      -> emit RENAME_GOAL with that goal's id and payload { title: "LeafCompute" }. NEVER CREATE_GOAL.
  User: "move my deep work block to Tuesday"        -> emit UPDATE_SCHEDULE_BLOCK with payload { dayOfWeek: 2 }. NEVER CREATE_SCHEDULE_BLOCK.

DO NOT DUPLICATE WHAT ALREADY EXISTS
Before proposing a CREATE_* action, scan "This week's context" for an existing item that already covers the user's ask. Specifically:
- CREATE_SCHEDULE_BLOCK: look at \`scheduleBlocks\` for the same dayOfWeek with an overlapping time window, or with the same title/category, or with the same linked goalId. If anything similar exists, DO NOT propose a new block. Instead either:
  (a) Propose UPDATE_SCHEDULE_BLOCK on the existing one if that better fits, or
  (b) Reply with a short clarifying question and 2-3 concrete options for the user to pick from. Example: "I see you already have a 'Deep work' block Mon 09:00-10:30 linked to OloStep. Do you want me to move it, extend it, or add a new block on a different day?" Then wait for their reply before emitting any proposal.
- CREATE_GOAL: check \`activeGoals\` for a goal with a similar title (case-insensitive substring match) or same category. If anything close exists, ask which they meant before proposing.
- CREATE_PRACTICE: check the "What you've already suggested (and the user accepted)" memory. If a similar practice is already accepted, acknowledge it and ask if they want to refine the existing one instead of adding a near-duplicate.

When you are confused or uncertain, ALWAYS ask a short clarifying question with 2-3 specific options grounded in what you actually see in the context. Never silently guess.

DEEN / SPIRITUAL CONTEXT
The Operator profile includes \`religiousContext\` and \`spiritualNotes\`. When \`religiousContext\` is not NONE, these are LOAD-BEARING — they describe the user's deen, the way they want their week framed, and the spiritual practices that anchor them. Use them:
- Read \`spiritualNotes\` carefully. If they mention salah, fajr, tahajjud, Qur'an, dhikr, tafsir, fasting, sadaqah, ihsan, barakah, tafakkur, istighfar — these are not buzzwords, they are tools you can suggest practices around.
- For ISLAM users, weave the deen into the FRAME of suggestions when natural — e.g. CREATE_PRACTICE for a morning deep-work block can be framed as "post-fajr deep work: ride the barakah of the early hours" with body referencing the user's spiritualNotes if relevant.
- The user trained you with this context for a reason. If you write a chat reply or propose a practice without ever acknowledging their deen on a question that touches mindset/discipline/purpose, you are under-using the context they gave you. Pull from \`spiritualNotes\` verbatim where it strengthens the framing.
- Never preach, never proselytize, never invent religious obligations they didn't mention. Only reflect back what they put in their profile.
- For religiousContext=NONE, ignore all of the above. Do not insert religious framing on your own.`;

// ---------- JSON schema for extraction ----------

const INSIGHT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: {
      type: 'array',
      minItems: 0,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'title', 'body', 'evidence'],
        properties: {
          kind: {
            type: 'string',
            enum: ['OBSERVATION', 'SUGGESTION', 'EXPERIMENT', 'MEDIA_PROMPT'],
          },
          title: { type: 'string', maxLength: 100 },
          body: { type: 'string', maxLength: 600 },
          evidence: { type: 'string', maxLength: 300 },
          suggestedAction: { type: 'string', maxLength: 200 },
          mediaSlot: {
            type: 'string',
            enum: ['BREAKFAST', 'LUNCH', 'EVENING', 'BEDTIME', 'ANY'],
          },
          mediaTopic: {
            type: 'string',
            enum: [
              'MINDSET',
              'CRAFT',
              'SPIRITUAL',
              'HABITS',
              'STRESS',
              'SLEEP',
              'DOPAMINE',
            ],
          },
        },
      },
    },
  },
};

type ExtractedInsight = {
  kind: CoachInsightKind;
  title: string;
  body: string;
  evidence: string;
  suggestedAction?: string;
  mediaSlot?: string;
  mediaTopic?: string;
};

interface ContextBundle {
  habitsProfile: HabitsProfile | null;
  recentCheckins: unknown[];
  recentJournal: unknown[];
  activeGoals: unknown[];
  weekReflections: unknown[];
  hoursByGoalThisWeek: Array<{ goalId: string; minutes: number }>;
  // Individual time entries from the last ~14 days, with IDs, so the
  // model can target a specific entry when emitting an
  // UPDATE_TIME_ENTRY / DELETE_TIME_ENTRY proposal (previously the
  // model only had aggregated totals and refused to edit because it
  // couldn't identify which entry to touch).
  recentTimeEntries: Array<{
    id: string;
    date: string;
    duration: number;
    taskName: string;
    taskId: string | null;
    goalId: string | null;
    goalTitle: string | null;
    notes: string | null;
  }>;
  scheduleBlocks: Array<
    Pick<
      ScheduleBlock,
      | 'id'
      | 'title'
      | 'dayOfWeek'
      | 'startTime'
      | 'endTime'
      | 'category'
      | 'isRecurring'
      | 'goalId'
    >
  >;
  acceptedInsights: CoachInsight[];
  weekKey: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Truncate to the start of the UTC calendar day. Used as the unique
 * key on SharedCoachUsage so the per-user daily quota resets at
 * 00:00 UTC regardless of where the user is in the world. Keeps the
 * quota predictable and matches when most free LLM provider tiers
 * reset (Google, OpenRouter, Groq all reset on a UTC boundary).
 */
function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}
const MEMORY_BLOCK_CAP = 800;

const ACTIVE_INSIGHT_STATUSES: CoachInsightStatus[] = ['ACCEPTED', 'DOING'];

const MEDIA_SLOTS = new Set([
  'BREAKFAST',
  'LUNCH',
  'EVENING',
  'BEDTIME',
  'ANY',
]);
const MEDIA_TOPICS = new Set([
  'MINDSET',
  'CRAFT',
  'SPIRITUAL',
  'HABITS',
  'STRESS',
  'SLEEP',
  'DOPAMINE',
]);
const KIND_VALUES = new Set<CoachInsightKind>([
  'OBSERVATION',
  'SUGGESTION',
  'EXPERIMENT',
  'MEDIA_PROMPT',
]);

@Injectable()
export class CoachAiService {
  private readonly logger = new Logger(CoachAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly llmFactory: LlmFactory,
  ) {}

  // ----- Public read endpoints -----

  async getLatestNarrative(userId: string, scopeKey: string) {
    const conv = await this.prisma.coachConversation.findUnique({
      where: {
        userId_scope_scopeKey: { userId, scope: CoachScope.NARRATIVE, scopeKey },
      },
    });
    if (!conv) {
      throw new HttpException('No narrative cached', HttpStatus.NOT_FOUND);
    }
    const msg = await this.prisma.coachMessage.findFirst({
      where: {
        conversationId: conv.id,
        role: { in: [CoachRole.SYSTEM_NARRATIVE, CoachRole.ASSISTANT] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!msg) {
      throw new HttpException('No narrative cached', HttpStatus.NOT_FOUND);
    }
    return msg;
  }

  async getChatHistory(userId: string, scopeKey: string) {
    const conv = await this.prisma.coachConversation.findUnique({
      where: {
        userId_scope_scopeKey: { userId, scope: CoachScope.CHAT, scopeKey },
      },
    });
    if (!conv) return { messages: [] };
    const messages = await this.prisma.coachMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
    });
    return { messages };
  }

  /**
   * Wipe the chat conversation for a single scope so the next message starts
   * clean. Narrative messages + accepted insights are NOT touched — the
   * Coach still remembers what the user committed to. Only the chat thread
   * row + its messages are removed (cascade delete via Prisma relation).
   */
  async clearChat(userId: string, scopeKey: string): Promise<void> {
    await this.prisma.coachConversation.deleteMany({
      where: { userId, scope: CoachScope.CHAT, scopeKey },
    });
  }

  /**
   * Delete the given chat message AND every later message in the same
   * conversation. Used when the user edits an old USER message: the edit
   * replaces that turn, so everything after it (the original assistant reply
   * + any subsequent back-and-forth) becomes stale. Removing it keeps the
   * LLM context lean and prevents the Coach from contradicting itself.
   *
   * Ownership: validated by checking the message's conversation belongs to
   * the user and matches scope+scopeKey.
   */
  async truncateChatFrom(
    userId: string,
    scopeKey: string,
    messageId: string,
  ): Promise<{ deleted: number }> {
    const message = await this.prisma.coachMessage.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (
      !message ||
      message.conversation.userId !== userId ||
      message.conversation.scope !== CoachScope.CHAT ||
      message.conversation.scopeKey !== scopeKey
    ) {
      throw new HttpException('Message not found', HttpStatus.NOT_FOUND);
    }
    const result = await this.prisma.coachMessage.deleteMany({
      where: {
        conversationId: message.conversationId,
        createdAt: { gte: message.createdAt },
      },
    });
    return { deleted: result.count };
  }

  /**
   * Turn an ASSISTANT chat reply into a tracked CoachInsight (status ACCEPTED
   * so it shows up in the user’s reminders immediately). User-driven: they
   * read the reply and decided this is worth keeping. Ownership check goes
   * through the conversation row.
   */
  async saveChatMessageAsInsight(
    userId: string,
    scopeKey: string,
    messageId: string,
    titleOverride?: string,
  ) {
    const message = await this.prisma.coachMessage.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (
      !message ||
      message.conversation.userId !== userId ||
      message.conversation.scope !== CoachScope.CHAT ||
      message.conversation.scopeKey !== scopeKey
    ) {
      throw new HttpException('Message not found', HttpStatus.NOT_FOUND);
    }
    if (message.role !== CoachRole.ASSISTANT) {
      throw new HttpException(
        'Only Coach replies can be saved as reminders.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const trimmed = (message.content ?? '').trim();
    const fallbackTitle = (() => {
      const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
      return firstSentence.length > 80
        ? firstSentence.slice(0, 77) + '...'
        : firstSentence;
    })();
    const title = (titleOverride ?? fallbackTitle).slice(0, 100) || 'Saved from chat';
    const body = trimmed.length > 600 ? trimmed.slice(0, 597) + '...' : trimmed;

    const insight = await this.prisma.coachInsight.create({
      data: {
        userId,
        scopeKey,
        sourceConversationId: message.conversationId,
        sourceMessageId: message.id,
        kind: 'SUGGESTION',
        title,
        body,
        evidence: 'Saved from a Coach chat reply.',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });

    return insight;
  }

  // ----- Streaming entry points -----

  /**
   * Stream the weekly narrative. If a cached narrative exists and `force`
   * is false, emit it as a single chunk + done without invoking the provider.
   * After a successful (live) stream, fire an async insight-extraction call
   * in the background — the SSE response has already closed by then.
   */
  async *streamNarrative(
    userId: string,
    scopeKey: string,
    force: boolean,
  ): AsyncGenerator<{ delta: string; done: boolean; error?: string }> {
    const resolved = await this.resolveCoachKey(userId);
    if (resolved.kind === 'byok') {
      await this.assertWithinBudget(resolved.byok);
    } else {
      await this.assertSharedQuota(userId);
    }

    const conversation = await this.findOrCreateConversation(
      userId,
      CoachScope.NARRATIVE,
      scopeKey,
    );

    if (!force) {
      const cached = await this.prisma.coachMessage.findFirst({
        where: {
          conversationId: conversation.id,
          role: { in: [CoachRole.SYSTEM_NARRATIVE, CoachRole.ASSISTANT] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (cached) {
        this.logger.log(
          `narrative cache hit scope=${scopeKey} user=${userId}`,
        );
        yield { delta: cached.content, done: false };
        yield { delta: '', done: true };
        return;
      }
    }

    const context = await this.buildContextBundle(userId, scopeKey);
    const messages = this.buildNarrativeMessages(context);

    // SECURITY: capture decrypted key into a local variable BEFORE opening the
    // stream so a concurrent DELETE cannot pull it out from under us.
    const decryptedKey =
      resolved.kind === 'byok'
        ? this.encryption.decrypt({
            ciphertext: Buffer.from(resolved.byok.ciphertext),
            iv: Buffer.from(resolved.byok.iv),
            authTag: Buffer.from(resolved.byok.authTag),
            keyVersion: resolved.byok.keyVersion,
          })
        : resolved.decryptedKey;
    const activeProvider =
      resolved.kind === 'byok' ? resolved.byok.provider : resolved.provider;
    const activeSelectedModel =
      resolved.kind === 'byok' ? resolved.byok.selectedModel : resolved.selectedModel;

    const result: { messageId?: string; fullText: string } = { fullText: '' };

    yield* this.runAndPersist({
      userId,
      conversationId: conversation.id,
      provider: activeProvider,
      decryptedKey,
      messages,
      persistRole: CoachRole.SYSTEM_NARRATIVE,
      scopeKey,
      result,
      selectedModel: activeSelectedModel,
      isShared: resolved.kind === 'shared',
    });

    if (result.fullText.length > 0 && result.messageId) {
      this.extractInsightsAsync({
        userId,
        scopeKey,
        conversationId: conversation.id,
        narrativeMessageId: result.messageId,
        narrativeText: result.fullText,
        provider: activeProvider,
        decryptedKey,
        contextBundle: context,
        selectedModel: activeSelectedModel,
      }).catch((err) =>
        this.logger.warn(
          `insight extraction failed user=${userId} scope=${scopeKey}: ${err?.message ?? err}`,
        ),
      );
    }
  }

  /**
   * Stream a chat reply. Persists the USER message BEFORE opening the stream
   * (retry safety) so a network blip during streaming doesn't drop the user's
   * input on the floor. Does NOT trigger insight extraction.
   */
  async *streamChatReply(
    userId: string,
    scopeKey: string,
    userContent: string,
  ): AsyncGenerator<{ delta: string; done: boolean; error?: string }> {
    const resolved = await this.resolveCoachKey(userId);
    if (resolved.kind === 'byok') {
      await this.assertWithinBudget(resolved.byok);
    } else {
      await this.assertSharedQuota(userId);
    }

    const conversation = await this.findOrCreateConversation(
      userId,
      CoachScope.CHAT,
      scopeKey,
    );

    // Persist USER message FIRST — retry safety.
    await this.prisma.coachMessage.create({
      data: {
        conversationId: conversation.id,
        role: CoachRole.USER,
        content: userContent,
      },
    });

    const history = await this.prisma.coachMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    });

    const context = await this.buildContextBundle(userId, scopeKey);
    const messages = this.buildChatMessages(context, history);

    const decryptedKey =
      resolved.kind === 'byok'
        ? this.encryption.decrypt({
            ciphertext: Buffer.from(resolved.byok.ciphertext),
            iv: Buffer.from(resolved.byok.iv),
            authTag: Buffer.from(resolved.byok.authTag),
            keyVersion: resolved.byok.keyVersion,
          })
        : resolved.decryptedKey;
    const activeProvider =
      resolved.kind === 'byok' ? resolved.byok.provider : resolved.provider;
    const activeSelectedModel =
      resolved.kind === 'byok' ? resolved.byok.selectedModel : resolved.selectedModel;

    const result: { messageId?: string; fullText: string } = { fullText: '' };

    yield* this.runAndPersist({
      userId,
      conversationId: conversation.id,
      provider: activeProvider,
      decryptedKey,
      messages,
      persistRole: CoachRole.ASSISTANT,
      scopeKey,
      result,
      selectedModel: activeSelectedModel,
      isShared: resolved.kind === 'shared',
    });
    // NOTE: chat does NOT trigger extraction.
  }

  // ----- Shared internals -----

  private async *runAndPersist(args: {
    userId: string;
    conversationId: string;
    provider: import('@prisma/client').CoachProvider;
    decryptedKey: string;
    messages: LlmChatMessage[];
    persistRole: CoachRole;
    scopeKey: string;
    result: { messageId?: string; fullText: string };
    selectedModel?: string | null;
    /** True when running against the operator's shared Gemini key
     *  instead of a user-owned BYOK row. Token counts are NOT charged
     *  to a non-existent BYOK row; daily message count is incremented
     *  on the user's SharedCoachUsage row instead. */
    isShared?: boolean;
  }): AsyncGenerator<{ delta: string; done: boolean; error?: string }> {
    const provider = this.llmFactory.create(args.provider, args.decryptedKey);
    const model = this.llmFactory.resolveModel(args.provider, args.selectedModel);

    let fullText = '';
    let usage: { promptTokens: number; completionTokens: number } | undefined;

    try {
      const stream = provider.streamCompletion(args.messages, model);
      for await (const chunk of stream as AsyncIterable<LlmStreamChunk>) {
        if (chunk.delta) fullText += chunk.delta;
        if (chunk.done) {
          usage = chunk.usage;
          break;
        } else {
          yield { delta: chunk.delta, done: false };
        }
      }
    } catch (err: any) {
      // SECURITY: do not leak the decrypted key. Only the high-level message.
      const message =
        err?.message && typeof err.message === 'string'
          ? err.message
          : 'LLM provider error';
      this.logger.warn(
        `LLM stream error scope=${args.scopeKey} user=${args.userId}: ${message}`,
      );
      yield { delta: '', done: true, error: message };
      return;
    }

    args.result.fullText = fullText;

    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;

    try {
      const ops: any[] = [
        this.prisma.coachMessage.create({
          data: {
            conversationId: args.conversationId,
            role: args.persistRole,
            content: fullText,
            promptTokens,
            completionTokens,
            model,
          },
        }),
      ];
      if (args.isShared) {
        // Shared-fallback path: increment the per-user daily message
        // counter so the next request is gated by the quota helper.
        const day = startOfUtcDay(new Date());
        ops.push(
          this.prisma.sharedCoachUsage.upsert({
            where: { userId_day: { userId: args.userId, day } },
            update: { messageCount: { increment: 1 } },
            create: { userId: args.userId, day, messageCount: 1 },
          }),
        );
      } else {
        ops.push(
          this.prisma.encryptedByokKey.update({
            where: { userId: args.userId },
            data: {
              tokensUsedThisMonth: { increment: totalTokens },
              lastValidatedAt: new Date(),
            },
          }),
        );
      }
      const [createdMsg] = await this.prisma.$transaction(ops);

      args.result.messageId = (createdMsg as { id: string }).id;

      this.logger.log(
        `coach stream done scope=${args.scopeKey} user=${args.userId} ` +
          `prompt=${promptTokens} completion=${completionTokens} model=${model}` +
          (args.isShared ? ' (shared)' : ''),
      );
    } catch (err: any) {
      this.logger.error(
        `failed to persist coach message scope=${args.scopeKey} user=${args.userId}: ${err?.message ?? err}`,
      );
      // Still close the SSE cleanly even if persistence fails.
    }

    yield { delta: '', done: true };
  }

  private async loadByokOr412(userId: string) {
    const byok = await this.prisma.encryptedByokKey.findUnique({
      where: { userId },
    });
    if (!byok) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PRECONDITION_FAILED,
          message: 'BYOK key not configured',
          error: 'PreconditionFailed',
        },
        HttpStatus.PRECONDITION_FAILED,
      );
    }
    return byok;
  }

  /**
   * Resolve which key/provider this user's next Coach call should use.
   *
   * Preference order:
   *   1. The user's own BYOK row (best — uses their quota, their model
   *      choice, their billing).
   *   2. The operator's shared Gemini Flash key from
   *      GOOGLE_AI_SHARED_API_KEY, gated by a per-user daily message
   *      count so one user can't drain the shared free tier for
   *      everyone else. Lets brand-new users try the Coach without
   *      signing up for any AI provider first.
   *
   * Throws PRECONDITION_FAILED only when both are unavailable (no
   * BYOK AND no shared key configured on the server).
   */
  private async resolveCoachKey(userId: string): Promise<
    | { kind: 'byok'; byok: import('@prisma/client').EncryptedByokKey }
    | {
        kind: 'shared';
        provider: import('@prisma/client').CoachProvider;
        decryptedKey: string;
        selectedModel: string;
      }
  > {
    const byok = await this.prisma.encryptedByokKey.findUnique({
      where: { userId },
    });
    if (byok) return { kind: 'byok', byok };

    const sharedKey = process.env.GOOGLE_AI_SHARED_API_KEY;
    if (sharedKey && sharedKey.length > 0) {
      return {
        kind: 'shared',
        provider: 'GEMINI',
        decryptedKey: sharedKey,
        selectedModel: 'gemini-2.5-flash',
      };
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.PRECONDITION_FAILED,
        message: 'BYOK key not configured',
        error: 'PreconditionFailed',
      },
      HttpStatus.PRECONDITION_FAILED,
    );
  }

  /**
   * Enforce the per-user daily cap on shared-key Coach calls. Reads
   * SHARED_COACH_DAILY_LIMIT from env (default 20). Throws 429 when
   * the user has hit it, with a message that nudges them to add their
   * own key for unlimited usage.
   */
  private async assertSharedQuota(userId: string): Promise<void> {
    const limit = parseInt(process.env.SHARED_COACH_DAILY_LIMIT ?? '20', 10);
    const day = startOfUtcDay(new Date());
    const usage = await this.prisma.sharedCoachUsage.findUnique({
      where: { userId_day: { userId, day } },
    });
    const used = usage?.messageCount ?? 0;
    if (used >= limit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            'Shared Coach daily limit reached. Add your own free Gemini or OpenRouter key in Settings to keep going.',
          error: 'TooManyRequests',
          shared: true,
          messagesUsedToday: used,
          dailyLimit: limit,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Read-only summary the BYOK state endpoint returns to the web app
   * so the Coach UI can show a "shared usage X of Y today" meter
   * before the user even sends a message.
   */
  async getSharedUsageSummary(userId: string): Promise<{
    available: boolean;
    used: number;
    limit: number;
  }> {
    const sharedKey = process.env.GOOGLE_AI_SHARED_API_KEY;
    if (!sharedKey || sharedKey.length === 0) {
      return { available: false, used: 0, limit: 0 };
    }
    const limit = parseInt(process.env.SHARED_COACH_DAILY_LIMIT ?? '20', 10);
    const day = startOfUtcDay(new Date());
    const usage = await this.prisma.sharedCoachUsage.findUnique({
      where: { userId_day: { userId, day } },
    });
    return {
      available: true,
      used: usage?.messageCount ?? 0,
      limit,
    };
  }

  private async assertWithinBudget(byok: {
    userId: string;
    tokensUsedThisMonth: number;
    tokensLimit: number;
    tokensWindowStart: Date;
  }) {
    const now = Date.now();
    const windowAgeMs = now - byok.tokensWindowStart.getTime();
    if (windowAgeMs > THIRTY_DAYS_MS) {
      // Reset window and re-read.
      const reset = await this.prisma.encryptedByokKey.update({
        where: { userId: byok.userId },
        data: {
          tokensUsedThisMonth: 0,
          tokensWindowStart: new Date(now),
        },
      });
      byok.tokensUsedThisMonth = reset.tokensUsedThisMonth;
      byok.tokensWindowStart = reset.tokensWindowStart;
    }

    if (byok.tokensUsedThisMonth >= byok.tokensLimit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Monthly token budget exceeded',
          error: 'TooManyRequests',
          tokensUsed: byok.tokensUsedThisMonth,
          tokensLimit: byok.tokensLimit,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async findOrCreateConversation(
    userId: string,
    scope: CoachScope,
    scopeKey: string,
  ) {
    const existing = await this.prisma.coachConversation.findUnique({
      where: { userId_scope_scopeKey: { userId, scope, scopeKey } },
    });
    if (existing) return existing;
    try {
      return await this.prisma.coachConversation.create({
        data: { userId, scope, scopeKey },
      });
    } catch (err) {
      // Race: another concurrent request just created it. Re-read.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const row = await this.prisma.coachConversation.findUnique({
          where: { userId_scope_scopeKey: { userId, scope, scopeKey } },
        });
        if (row) return row;
      }
      throw err;
    }
  }

  // ----- Context assembly -----

  private async buildContextBundle(
    userId: string,
    scopeKey: string,
  ): Promise<ContextBundle> {
    const habitsProfile = await this.prisma.habitsProfile.findUnique({
      where: { userId },
    });

    const recentCheckins = await this.prisma.dailyCheckin.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 7,
    });

    const recentJournalRaw = await this.prisma.journalEntry.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 14,
    });
    const recentJournal = recentJournalRaw.map((j) => ({
      date: j.date,
      mood: j.mood,
      energy: j.energy,
      content: capText(stripHtml(j.content), 500),
    }));

    const activeGoals = await this.prisma.goal.findMany({
      where: { userId, status: 'ACTIVE' as any },
      select: {
        id: true,
        title: true,
        deadline: true,
        loggedHours: true,
        status: true,
      },
    });

    const weekReflections = await this.prisma.goalReflection.findMany({
      where: { userId, weekKey: scopeKey },
    });

    const { from, to } = isoWeekRange(scopeKey);
    const hoursByGoalThisWeek = await this.aggregateHoursByGoal(
      userId,
      from,
      to,
    );

    // Last ~14 days of individual time entries with IDs so the model
    // can emit precise UPDATE/DELETE proposals. Goals are inner-joined
    // for the title — saves the model a lookup when it explains the
    // proposal to the user.
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const recentTimeEntriesRaw = await this.prisma.timeEntry.findMany({
      where: { userId, date: { gte: fourteenDaysAgo } },
      orderBy: { date: 'desc' },
      take: 80,
      select: {
        id: true,
        date: true,
        duration: true,
        taskName: true,
        taskId: true,
        goalId: true,
        notes: true,
        goal: { select: { title: true } },
      },
    });
    const recentTimeEntries = recentTimeEntriesRaw.map((e) => ({
      id: e.id,
      date: e.date.toISOString().slice(0, 10),
      duration: e.duration,
      taskName: e.taskName,
      taskId: e.taskId,
      goalId: e.goalId,
      goalTitle: e.goal?.title ?? null,
      notes: e.notes,
    }));

    const scheduleBlocksRaw = await this.prisma.scheduleBlock.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        category: true,
        isRecurring: true,
        goalId: true,
      },
    });

    const acceptedInsights = await this.prisma.coachInsight.findMany({
      where: { userId, status: { in: ACTIVE_INSIGHT_STATUSES } },
      orderBy: [{ startedDoingAt: 'desc' }, { acceptedAt: 'desc' }],
      take: 20,
    });

    return {
      habitsProfile,
      recentCheckins,
      recentJournal,
      activeGoals,
      weekReflections,
      hoursByGoalThisWeek,
      recentTimeEntries,
      scheduleBlocks: scheduleBlocksRaw,
      acceptedInsights,
      weekKey: scopeKey,
    };
  }

  private async aggregateHoursByGoal(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ goalId: string; minutes: number }>> {
    const rows = await this.prisma.timeEntry.groupBy({
      by: ['goalId'],
      where: {
        userId,
        date: { gte: from, lte: to },
        goalId: { not: null },
      },
      _sum: { duration: true },
    });
    return rows
      .filter((r) => r.goalId !== null)
      .map((r) => ({
        goalId: r.goalId as string,
        minutes: r._sum.duration ?? 0,
      }));
  }

  // ----- Prompt rendering -----

  private buildNarrativeMessages(ctx: ContextBundle): LlmChatMessage[] {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserContextMessage(ctx, 'narrative') },
    ];
  }

  private buildChatMessages(
    ctx: ContextBundle,
    history: Array<{ role: CoachRole; content: string }>,
  ): LlmChatMessage[] {
    const messages: LlmChatMessage[] = [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: buildUserContextMessage(ctx, 'chat') },
      // The user-context message above plays the role of "Context" the chat
      // system prompt references; subsequent turns are the chat itself.
    ];
    for (const m of history) {
      if (m.role === CoachRole.USER) {
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === CoachRole.ASSISTANT) {
        messages.push({ role: 'assistant', content: m.content });
      }
      // SYSTEM_NARRATIVE messages are intentionally omitted from chat history.
    }
    return messages;
  }

  // ----- Insight extraction -----

  private async extractInsightsAsync(args: {
    userId: string;
    scopeKey: string;
    conversationId: string;
    narrativeMessageId: string;
    narrativeText: string;
    provider: import('@prisma/client').CoachProvider;
    decryptedKey: string;
    contextBundle: ContextBundle;
    selectedModel?: string | null;
  }): Promise<void> {
    try {
      const provider = this.llmFactory.create(
        args.provider,
        args.decryptedKey,
      );
      const model = this.llmFactory.resolveModel(args.provider, args.selectedModel);

      const contextJson = JSON.stringify(
        serializeContextForExtraction(args.contextBundle),
      );
      const userMessage = `CONTEXT:\n${contextJson}\n\nNARRATIVE:\n${args.narrativeText}`;

      const messages: LlmChatMessage[] = [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ];

      const { data, usage } = await provider.extractStructured<{
        insights?: unknown;
      }>({
        messages,
        model,
        schemaName: 'extract_coach_insights',
        schema: INSIGHT_SCHEMA,
      });

      const rawInsights = Array.isArray((data as any)?.insights)
        ? ((data as any).insights as unknown[])
        : [];

      const validated: ExtractedInsight[] = [];
      for (const raw of rawInsights) {
        const item = validateInsight(raw);
        if (item) validated.push(item);
      }

      // Dedupe against currently-active insight titles via normalized Levenshtein
      // similarity.
      const activeTitles = args.contextBundle.acceptedInsights.map((i) =>
        i.title.toLowerCase(),
      );
      const survivors = validated.filter((item) => {
        const t = item.title.toLowerCase();
        for (const existing of activeTitles) {
          if (normalizedSimilarity(t, existing) > 0.85) return false;
        }
        return true;
      });

      const totalTokens =
        (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);

      if (survivors.length === 0) {
        // Still count the tokens even when nothing survives.
        await this.prisma.encryptedByokKey.update({
          where: { userId: args.userId },
          data: { tokensUsedThisMonth: { increment: totalTokens } },
        });
        this.logger.log(
          `insight extraction produced 0 survivors user=${args.userId} scope=${args.scopeKey} prompt=${usage.promptTokens} completion=${usage.completionTokens} model=${model}`,
        );
        return;
      }

      const inserts = survivors.map((item) =>
        this.prisma.coachInsight.create({
          data: {
            userId: args.userId,
            sourceConversationId: args.conversationId,
            sourceMessageId: args.narrativeMessageId,
            scopeKey: args.scopeKey,
            kind: item.kind,
            title: item.title,
            body: item.body,
            evidence: item.evidence,
            suggestedAction: item.suggestedAction ?? null,
            mediaSlot:
              item.kind === 'MEDIA_PROMPT' ? item.mediaSlot ?? null : null,
            mediaTopic:
              item.kind === 'MEDIA_PROMPT' ? item.mediaTopic ?? null : null,
          },
        }),
      );

      await this.prisma.$transaction([
        ...inserts,
        this.prisma.encryptedByokKey.update({
          where: { userId: args.userId },
          data: { tokensUsedThisMonth: { increment: totalTokens } },
        }),
      ]);

      this.logger.log(
        `insight extraction persisted=${survivors.length} dropped=${validated.length - survivors.length} user=${args.userId} scope=${args.scopeKey} prompt=${usage.promptTokens} completion=${usage.completionTokens} model=${model}`,
      );
    } catch (err: any) {
      // NEVER rethrow — narrative is already saved and SSE closed.
      this.logger.warn(
        `extractInsightsAsync threw user=${args.userId} scope=${args.scopeKey}: ${err?.message ?? err}`,
      );
    }
  }
}

// ===== Pure helpers (exported for tests, but kept module-local) =====

/**
 * Strip HTML tags without pulling in a parser library.
 */
export function stripHtml(s: string): string {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/**
 * Convert a scopeKey into a [from, to] Date range. Supports four shapes:
 *   "YYYY-Www"  ISO week, Monday 00:00 through Sunday 23:59:59.999 UTC
 *   "YYYY-Mmm"  Calendar month, day 1 through last day 23:59:59.999 UTC
 *   "YYYY-Qq"   Quarter (q in 1..4), 3-month span UTC
 *   "YYYY"      Full calendar year UTC
 * If parsing fails, defaults to the current ISO week. Function name kept
 * for back-compat with existing callers.
 */
export function isoWeekRange(scopeKey: string): { from: Date; to: Date } {
  // Year
  let m: RegExpExecArray | null = /^(\d{4})$/.exec(scopeKey);
  if (m) {
    const y = Number(m[1]);
    const from = new Date(Date.UTC(y, 0, 1));
    const to = new Date(Date.UTC(y + 1, 0, 1));
    to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
    return { from, to };
  }
  // Quarter
  m = /^(\d{4})-Q([1-4])$/.exec(scopeKey);
  if (m) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    const startMonth = (q - 1) * 3;
    const from = new Date(Date.UTC(y, startMonth, 1));
    const to = new Date(Date.UTC(y, startMonth + 3, 1));
    to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
    return { from, to };
  }
  // Month
  m = /^(\d{4})-M(\d{2})$/.exec(scopeKey);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const from = new Date(Date.UTC(y, mo, 1));
    const to = new Date(Date.UTC(y, mo + 1, 1));
    to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
    return { from, to };
  }
  // Week (default)
  m = /^(\d{4})-W(\d{1,2})$/.exec(scopeKey);
  if (!m) {
    return currentIsoWeekRange();
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const from = new Date(week1Monday);
  from.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const to = new Date(from);
  to.setUTCDate(from.getUTCDate() + 7);
  to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
  return { from, to };
}

function currentIsoWeekRange(): { from: Date; to: Date } {
  const now = new Date();
  const dow = now.getUTCDay() || 7;
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  from.setUTCDate(from.getUTCDate() - (dow - 1));
  const to = new Date(from);
  to.setUTCDate(from.getUTCDate() + 7);
  to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
  return { from, to };
}

// ----- Memory + prompt construction helpers -----

function weeksAgoLabel(when: Date | null | undefined, now: Date = new Date()): string {
  if (!when) return 'recently';
  const ms = now.getTime() - when.getTime();
  const weeks = Math.max(0, Math.round(ms / (7 * 24 * 60 * 60 * 1000)));
  if (weeks <= 0) return 'this week';
  if (weeks === 1) return 'last week';
  return `${weeks} weeks ago`;
}

export function formatMemoryBlock(
  insights: CoachInsight[],
  cap: number = MEMORY_BLOCK_CAP,
  now: Date = new Date(),
): string {
  // Sort by acceptedAt desc as the canonical "freshest first" order. We then
  // FIFO-trim by dropping the OLDEST first if we exceed the cap. To do that
  // we build oldest-first, then drop from the front until it fits.
  const sortedOldestFirst = [...insights].sort((a, b) => {
    const aT = (a.acceptedAt ?? a.createdAt).getTime();
    const bT = (b.acceptedAt ?? b.createdAt).getTime();
    return aT - bT;
  });

  const lines: string[] = sortedOldestFirst.map((i) => {
    const ago = weeksAgoLabel(i.acceptedAt ?? i.createdAt, now);
    const action = i.suggestedAction ? `: ${i.suggestedAction}` : '';
    return `[ACCEPTED ${ago}, status=${i.status}] ${i.title}${action}`;
  });

  // FIFO trim: drop oldest until total length <= cap.
  while (lines.length > 0 && lines.join('\n').length > cap) {
    lines.shift();
  }

  // Reverse so freshest appears first (more useful to the model).
  return lines.reverse().join('\n');
}

function buildUserContextMessage(
  ctx: ContextBundle,
  mode: 'narrative' | 'chat',
): string {
  const h = ctx.habitsProfile;
  const religiousContext =
    (h?.religiousContext as ReligiousContext | undefined) ??
    ReligiousContext.NONE;

  const opLines: string[] = [];
  opLines.push(`why: ${h?.why?.trim() ? h.why.trim() : '(not set)'}`);
  opLines.push(`religiousContext: ${religiousContext}`);
  if (religiousContext !== ReligiousContext.NONE) {
    const notes = (h?.spiritualNotes ?? '').trim();
    opLines.push(`spiritualNotes: ${notes.length ? notes : '(none)'}`);
  }
  opLines.push(
    `sleepTarget: ${h?.sleepTargetHours ?? 8}h, bedtime ${h?.bedtime ?? '23:00'}, wake ${h?.wakeTime ?? '07:00'}`,
  );
  opLines.push(
    `work env: ${h?.workEnvironment?.trim() ? h.workEnvironment.trim() : '(unspecified)'}`,
  );

  const memory = formatMemoryBlock(ctx.acceptedInsights);
  const memorySection = memory.length ? memory : '(none yet)';

  // The "rest of bundle" sent as JSON — exclude habitsProfile (already
  // formatted in Operator profile) and acceptedInsights (formatted as
  // memory) to keep the payload smaller and avoid duplication.
  const rest = {
    weekKey: ctx.weekKey,
    recentCheckins: ctx.recentCheckins,
    recentJournal: ctx.recentJournal,
    activeGoals: ctx.activeGoals,
    weekReflections: ctx.weekReflections,
    hoursByGoalThisWeek: ctx.hoursByGoalThisWeek,
    recentTimeEntries: ctx.recentTimeEntries,
    scheduleBlocks: ctx.scheduleBlocks,
  };

  // Surface unlinked schedule blocks + linkable goals as plain-text sections
  // so the model cannot bury them in the JSON dump. Drives the proactive
  // "link blocks to goals" rule reliably.
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fmt12h = (t: string): string => {
    const [hStr, mStr] = (t || '').split(':');
    const h = Number(hStr);
    const m = Number(mStr);
    if (Number.isNaN(h) || Number.isNaN(m)) return t;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const dh = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${dh}:${m.toString().padStart(2, '0')} ${ampm}`;
  };
  const unlinkedBlocks = (ctx.scheduleBlocks ?? []).filter((b) => !b.goalId);
  const unlinkedSection = unlinkedBlocks.length
    ? unlinkedBlocks
        .map(
          (b) =>
            `  - id=${b.id} | "${b.title}" | ${dayNames[b.dayOfWeek] ?? '?'} ${fmt12h(b.startTime)} to ${fmt12h(b.endTime)} | category=${b.category ?? 'none'}`,
        )
        .join('\n')
    : '  (none, all blocks are linked to goals)';
  const goalsListSection = (ctx.activeGoals ?? []).length
    ? (ctx.activeGoals ?? [])
        .map((g: { id: string; title: string }) => `  - id=${g.id} | "${g.title}"`)
        .join('\n')
    : '  (no active goals)';

  // Plain-text recent time entries — mirrors the unlinkedBlocks /
  // goalsList pattern so the model can grab IDs without parsing the
  // JSON dump. Capped at 30 lines (most recent first) to keep the
  // prompt size sane; the full 80 is still in the JSON blob below.
  const recentEntriesSection = (ctx.recentTimeEntries ?? []).length
    ? (ctx.recentTimeEntries ?? [])
        .slice(0, 30)
        .map((e) => {
          const goal = e.goalTitle ? `goal="${e.goalTitle}"` : 'goal=(none)';
          const task = e.taskName ? `"${e.taskName}"` : '(no task title)';
          return `  - id=${e.id} | ${e.date} | ${e.duration}m | ${task} | ${goal}`;
        })
        .join('\n')
    : '  (no time entries in the last 14 days)';

  const intro =
    mode === 'narrative'
      ? "Write this week's narrative for me. Reference specific data points. Close with one Socratic question."
      : 'Reply to my next message using the context below.';

  return [
    intro,
    '',
    '## Operator profile',
    opLines.join('\n'),
    '',
    "## What you've already suggested (and the user accepted)",
    memorySection,
    '',
    '## UNLINKED schedule blocks (no goalId, user cannot log time against them)',
    unlinkedSection,
    '',
    '## Active goals you can link blocks to',
    goalsListSection,
    '',
    '## Recent time entries (use these IDs for UPDATE_TIME_ENTRY / DELETE_TIME_ENTRY proposals — never invent an id)',
    recentEntriesSection,
    '',
    "## This week's context (full JSON)",
    JSON.stringify(rest),
  ].join('\n');
}

function serializeContextForExtraction(ctx: ContextBundle) {
  // Smaller subset to feed the extraction call — it only needs to know
  // what the narrative was based on plus the Operator profile.
  const h = ctx.habitsProfile;
  return {
    weekKey: ctx.weekKey,
    operator: h
      ? {
          why: h.why,
          religiousContext: h.religiousContext,
          spiritualNotes: h.spiritualNotes,
          sleepTargetHours: h.sleepTargetHours,
          bedtime: h.bedtime,
          wakeTime: h.wakeTime,
          workEnvironment: h.workEnvironment,
        }
      : null,
    activeGoals: ctx.activeGoals,
    weekReflections: ctx.weekReflections,
    hoursByGoalThisWeek: ctx.hoursByGoalThisWeek,
    recentCheckins: ctx.recentCheckins,
    recentJournal: ctx.recentJournal,
    scheduleBlocks: ctx.scheduleBlocks,
    acceptedInsightTitles: ctx.acceptedInsights.map((i) => i.title),
  };
}

// ----- Validation -----

function validateInsight(raw: unknown): ExtractedInsight | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== 'string' || !KIND_VALUES.has(kind as CoachInsightKind)) {
    return null;
  }
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const body = typeof r.body === 'string' ? r.body.trim() : '';
  const evidence = typeof r.evidence === 'string' ? r.evidence.trim() : '';
  if (!title || title.length > 100) return null;
  if (!body || body.length > 600) return null;
  if (!evidence || evidence.length > 300) return null;

  const suggestedAction =
    typeof r.suggestedAction === 'string'
      ? r.suggestedAction.trim()
      : undefined;
  if (suggestedAction && suggestedAction.length > 200) return null;

  let mediaSlot: string | undefined;
  let mediaTopic: string | undefined;
  if (kind === 'MEDIA_PROMPT') {
    mediaSlot = typeof r.mediaSlot === 'string' ? r.mediaSlot : undefined;
    mediaTopic = typeof r.mediaTopic === 'string' ? r.mediaTopic : undefined;
    if (!mediaSlot || !MEDIA_SLOTS.has(mediaSlot)) return null;
    if (!mediaTopic || !MEDIA_TOPICS.has(mediaTopic)) return null;
  }

  return {
    kind: kind as CoachInsightKind,
    title,
    body,
    evidence,
    suggestedAction: suggestedAction || undefined,
    mediaSlot,
    mediaTopic,
  };
}

// ----- Levenshtein for dedupe -----

export function normalizedSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const d = levenshtein(a, b);
  return 1 - d / maxLen;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Two-row DP.
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
