import {
  allActions,
  applyInMemory,
  block,
  claimsBulletsInsideBlock,
  EvalBlock,
  idsOf,
  minutes,
  ParsedReply,
  touchedIds,
  Turn,
} from './harness';

/**
 * The week from the conversation that started this suite (ids regenerated,
 * a few personal titles made generic). Note what makes it hard: "Reading &
 * Labs (Core Engineering)" is only on Tue and Thu, "Book" is Tue to Fri but
 * not Monday, "Community Time" runs every day, and Work starts the moment
 * Book ends.
 */
const WEEKDAYS = [1, 2, 3, 4, 5];
export const REAL_WEEK: EvalBlock[] = [
  ...block('Morning Prayer', [0, 1, 2, 5, 6], '04:30', '05:00', 'SPIRITUAL'),
  ...block('Family Time', [0, 1, 2, 3, 4, 5, 6], '05:00', '06:00', 'FAMILY'),
  ...block('Tech Podcast', [0], '06:00', '07:00'),
  ...block('Morning Lecture', WEEKDAYS, '06:00', '07:00', 'SPIRITUAL'),
  ...block('Morning Podcast', [6], '06:00', '07:00', 'SPIRITUAL'),
  ...block('Deep Reading', [0, 6], '07:00', '13:00'),
  ...block('Reading & Labs (Core Engineering)', [2, 4], '07:00', '09:00'),
  ...block('Book', [2, 3, 4, 5], '09:00', '11:00'),
  ...block('Work', WEEKDAYS, '11:00', '16:00', 'WORK'),
  ...block('Career Strategy and Applications', [0], '13:00', '15:00', 'CAREER'),
  ...block('Branding and Great Content', [6], '13:00', '15:00', 'CAREER'),
  ...block(
    'Community Time',
    [0, 1, 2, 3, 4, 5, 6],
    '16:00',
    '17:00',
    'COMMUNITY',
  ),
  ...block('LeafCompute', WEEKDAYS, '17:00', '19:00', 'WORK'),
  ...block('Family Time', [0], '17:00', '21:00', 'FAMILY'),
  ...block('Friends and Community', [6], '17:00', '21:00', 'COMMUNITY'),
  ...block(
    'Dinner, Arabic and Family time',
    WEEKDAYS,
    '19:00',
    '20:00',
    'FAMILY',
  ),
  ...block('Read Paper and Take notes', [2, 3, 4, 5], '20:00', '21:00'),
];

const READING = 'Reading & Labs (Core Engineering)';
const readingIds = idsOf(REAL_WEEK, READING);

export interface Scenario {
  id: string;
  /** What a real user asks; quoted from production where noted. */
  description: string;
  blocks: EvalBlock[];
  turns: Turn[];
  applyNotes?: Record<string, string>;
  /**
   * Set when the CURRENT recording is known to fail, with why. The suite then
   * expects it to fail (and says so when it starts passing), so a known model
   * miss stays visible without turning every `npm test` red. Clear it once a
   * fresh live recording passes.
   */
  knownFailure?: string;
  /** True when the right answer is a proposal; false when it is prose only. */
  expectProposal: boolean | 'either';
  check: (r: ParsedReply, blocks: EvalBlock[]) => string[];
}

const fail = (cond: boolean, msg: string): string[] => (cond ? [msg] : []);

function onDays(
  final: EvalBlock[],
  title: RegExp,
  days: number[],
): EvalBlock[] {
  return final.filter((b) => title.test(b.title) && days.includes(b.dayOfWeek));
}

function insideSlot(b: EvalBlock, start: string, end: string): boolean {
  return b.startTime >= start && b.endTime <= end;
}

/** A user-visible mention that freed time exists (bug 5). */
const MENTIONS_FREED =
  /(free[sd]?|left over|leftover|remaining|extra|spare|open|unused|empty)\b[^.\n]{0,80}(hour|time|8:00|8 ?AM|slot|minutes)|(hour|time|8:00|8 ?AM)[^.\n]{0,60}(free|open|left over|unused)/i;

/** A user-visible statement that blocks only hold a title (bug 4). */
const SAYS_TITLE_ONLY =
  /(title only|only (holds?|stores?|keeps?|has|have|supports?) (a |the )?title|blocks? (can|do|does)n?'?t? (only )?(hold|store|have|support)[^.\n]{0,40}(title|bullet|description|notes|list|sub)|no (description|notes|bullet|sub-?item)|can(not|'t) (store|hold|save|keep|add) (bullets|a list|sub|description|notes|topics))/i;

const WEEKEND_ASK = `- Keep the schedule block "Reading and Labs" but make that "Core Engineering" and add one more lab. - 30-minute lab first for soft skills and a 30-minute lab again for the technical side, which will have system design, database challenges, system design challenges, and AI engineering agents challenges. This is 2 labs, 30 minutes each. - We will spend 3 hours on code engineering study. Currently it is named "Book" and we will just call it "Study". - "Work" will continue. - For "Community Time" at 4 pm, let's replace it with "Dev Weekends" and rename it to "Dev Weekends". - At 5 pm, again, "Talking About Weekdays" stays there. - On weekends replace "Community Time" with "Dev Weekends".   Also for the weekend, can you move my career strategy and branding to 7 am ?  and at 8 am we do Founder Interviews Prep per project   Deep engineering reading moves to 9 am until 12 pm. After that we have 12 pm to 2 pm as the community time`;

export const SCENARIOS: Scenario[] = [
  {
    id: 'weekend-restructure',
    description:
      'Production headline (gpt-4o-mini, 2026-11-06): the multi-part weekday request plus a weekend reshuffle where every move depends on another block shrinking first',
    blocks: REAL_WEEK,
    turns: [{ role: 'user', content: WEEKEND_ASK }],
    expectProposal: true,
    check: (r, blocks) => {
      const final = applyInMemory(blocks, r);
      const ids = touchedIds(r, blocks);
      const weekend = [0, 6];
      const deepReading = onDays(final, /deep reading/i, weekend);
      const founders = onDays(final, /founder/i, weekend);
      const career = final.find((b) => /career strategy/i.test(b.title));
      const branding = final.find((b) => /branding/i.test(b.title));
      const labs = final.filter(
        (b) => b.id.startsWith('new-') && /lab|soft/i.test(b.title),
      );
      const family = idsOf(blocks, 'Family Time');
      return [
        ...fail(
          !readingIds.every((id) => ids.has(id)),
          'Reading & Labs is not handled on both Tue and Thu',
        ),
        ...fail(
          labs.length < 4 || labs.some((b) => !insideSlot(b, '07:00', '09:00')),
          'labs are not inside the 7:00 to 9:00 AM Core Engineering window on Tue and Thu',
        ),
        ...fail(
          final
            .filter((b) => b.title === 'Community Time')
            .some((b) => [1, 2, 3, 4, 5].includes(b.dayOfWeek)),
          'weekday Community Time is not renamed to Dev Weekends',
        ),
        ...fail(
          deepReading.length !== 2 ||
            deepReading.some(
              (b) => b.startTime !== '09:00' || b.endTime !== '12:00',
            ),
          'Deep Reading is not 9:00 AM to 12:00 PM on both Saturday and Sunday',
        ),
        ...fail(
          founders.length !== 2 ||
            founders.some((b) => b.startTime !== '08:00'),
          'Founder Interviews Prep is not at 8:00 AM on both weekend days',
        ),
        ...fail(
          !career || career.startTime !== '07:00' || career.dayOfWeek !== 0,
          'Career Strategy is not at 7:00 AM on Sunday',
        ),
        ...fail(
          !branding ||
            branding.startTime !== '07:00' ||
            branding.dayOfWeek !== 6,
          'Branding is not at 7:00 AM on Saturday',
        ),
        ...fail(
          family.some((id) => ids.has(id)) ||
            final.some((b) => b.id.startsWith('new-') && b.startTime < '06:00'),
          'touches the 5 AM family block or invents a block before 6 AM',
        ),
        ...fail(
          !/(3|three)[ -]hours?|\?/i.test(r.prose),
          'does not ask about the 3 hours of Study that would run into Work',
        ),
      ];
    },
  },
  {
    id: 'replace-one-with-two',
    description:
      'Production: replace Reading & Labs with two 30-minute blocks, one listing four lab topics as bullets',
    blocks: REAL_WEEK,
    turns: [
      {
        role: 'user',
        content:
          'in schedule can we replce Reading & Labs (Core Engineering) with 2 blocks of 30 minutes one for soft skills and one for tech labs with bullets of System Design Labs, and then db challenges labs and then System Design Challenges Labs then AI Agentic challenges labs',
      },
    ],
    expectProposal: true,
    check: (r, blocks) => {
      const final = applyInMemory(blocks, r);
      // The replacements are either new blocks or, when the Coach used
      // SPLIT_SCHEDULE_BLOCK, the original block re-titled as the first
      // piece. Both count; what matters is what sits in the slot afterwards.
      const replacements = (day: number) =>
        final.filter(
          (b) =>
            b.dayOfWeek === day &&
            !/Reading & Labs/.test(b.title) &&
            (b.id.startsWith('new-') || readingIds.includes(b.id)),
        );
      const reading = onDays(final, /Reading & Labs/, [2, 4]);
      const perDay = [2, 4].map(replacements);
      const newOnes = perDay.flat();
      return [
        ...fail(
          reading.length > 0,
          'Reading & Labs is not replaced on both days it occurs (Tue and Thu)',
        ),
        ...fail(
          perDay.some((d) => d.length !== 2),
          `expected 2 replacement blocks on each of Tue and Thu, found ${perDay.map((d) => d.length).join(' and ')}`,
        ),
        ...fail(
          newOnes.some((b) => !insideSlot(b, '07:00', '09:00')),
          'a replacement block is placed outside the 7:00 to 9:00 AM slot it replaces',
        ),
        ...fail(
          newOnes.some((b) => minutes(b) !== 30),
          'a replacement block is not 30 minutes',
        ),
        ...fail(
          perDay.some(
            (d) =>
              d.length === 2 &&
              [d[0].startTime, d[1].startTime].sort().join() !== '07:00,07:30',
          ),
          'the two replacements do not sit back to back from 7:00 AM',
        ),
        ...fail(
          claimsBulletsInsideBlock(r.prose),
          'claims to store the bullets inside a block',
        ),
        ...fail(
          !SAYS_TITLE_ONLY.test(r.prose) &&
            !newOnes.some((b) => /system design/i.test(b.title)),
          'neither puts the topics in the title nor says blocks hold a title only',
        ),
        ...fail(
          !MENTIONS_FREED.test(r.prose),
          'does not mention the hour this frees',
        ),
      ];
    },
  },
  {
    id: 'remove-on-all-weekdays',
    description:
      'Production: "remove Reading & Labs on all weekdays" when it only exists Tue and Thu',
    blocks: REAL_WEEK,
    turns: [
      {
        role: 'user',
        content:
          'first remove Reading & Labs (Core Engineering) on all weekdays',
      },
    ],
    expectProposal: true,
    check: (r) => {
      const deletes = allActions(r).filter(
        (a) => a.type === 'DELETE_SCHEDULE_BLOCK',
      );
      return [
        ...fail(
          deletes.length !== 2,
          `expected exactly 2 deletes (Tue, Thu), got ${deletes.length}`,
        ),
        ...fail(
          !readingIds.every((id) => deletes.some((d) => d.id === id)),
          'does not delete both real occurrences',
        ),
        ...fail(
          !/tue/i.test(r.prose) || !/thu/i.test(r.prose),
          'does not tell the user it only occurs on Tuesday and Thursday',
        ),
      ];
    },
  },
  {
    id: 'follow-up-after-refused-apply',
    description:
      'Production: the first card was refused (made-up id, guessed time); the user says to fix it',
    blocks: REAL_WEEK,
    turns: [
      {
        role: 'user',
        content:
          'replace Reading & Labs (Core Engineering) with 2 blocks of 30 minutes, Soft Skills and Tech Labs',
      },
      {
        id: 'bad-proposal',
        role: 'assistant',
        content:
          'Here is the change.\n\n```coach-proposal\n{"summary":"Replace Reading & Labs","actions":[{"type":"DELETE_SCHEDULE_BLOCK","id":"b927183f-2111-4f25-853c-e6328939c640"},{"type":"CREATE_SCHEDULE_BLOCK","payload":{"title":"Soft Skills","startTime":"09:00","endTime":"09:30","dayOfWeek":1,"category":"LEARNING"}},{"type":"CREATE_SCHEDULE_BLOCK","payload":{"title":"Tech Labs","startTime":"09:30","endTime":"10:00","dayOfWeek":1,"category":"LEARNING"}}]}\n```',
      },
      {
        role: 'user',
        content: 'it failed. first remove the block then add new',
      },
    ],
    applyNotes: {
      'bad-proposal':
        "\n\n[App note, not written by you: the user clicked Apply on the proposal above. Outcome: REFUSED before anything was written. Nothing in this proposal was applied; the schedule is unchanged.\n  1. Delete 'Reading & Labs (Core Engineering)': FAILED: This block is not in your schedule, so nothing was deleted. The Coach referenced a block id that does not exist.\n  2. Add 'Soft Skills' Mon 9:00 AM to 9:30 AM: not attempted\n  3. Add 'Tech Labs' Mon 9:30 AM to 10:00 AM: not attempted\nThe schedule in your context is the state AFTER this. If the user asks you to fix or retry, work from these results and the current schedule. Never re-send an action that failed for the same reason.]",
    },
    expectProposal: true,
    check: (r, blocks) => {
      const ids = touchedIds(r, blocks);
      const final = applyInMemory(blocks, r);
      const newOnes = final.filter((b) => b.id.startsWith('new-'));
      return [
        ...fail(
          ids.has('b927183f-2111-4f25-853c-e6328939c640'),
          're-sends the made-up id that failed',
        ),
        ...fail(
          !readingIds.every((id) => ids.has(id)),
          'does not target both real Reading & Labs ids',
        ),
        ...fail(
          newOnes.some(
            (b) =>
              !insideSlot(b, '07:00', '09:00') || ![2, 4].includes(b.dayOfWeek),
          ),
          'places new blocks outside Reading & Labs slot',
        ),
      ];
    },
  },
  {
    id: 'multi-part-restructure',
    knownFailure:
      'Recorded 2026-11-06 before the "blocks the user said stay are off limits" rule: the model moved Work to 12:00 to 5:00 PM to fit 3 hours of Study, which the apply preflight refuses (overlaps Dev Weekends). Re-record live.',
    description:
      'Owner request: several changes in one voice-typed message (rename, add labs, extend Book, rename Community Time, a block name that does not exist)',
    blocks: REAL_WEEK,
    turns: [
      {
        role: 'user',
        content: [
          '- Keep the schedule block "Reading and Labs" but make that "Core Engineering" and add one more lab.',
          '- 30-minute lab first for soft skills and a 30-minute lab again for the technical side, which will have system design, database challenges, system design challenges, and AI engineering agents challenges. This is 2 labs, 30 minutes each.',
          '- We will spend 3 hours on code engineering study. Currently it is named "Book" and we will just call it "Study".',
          '- "Work" will continue.',
          '- For "Community Time" at 4 pm, let\'s replace it with "Dev Weekends" and rename it to "Dev Weekends".',
          '- At 5 pm, again, "Talking About Weekdays" stays there.',
          '- On weekends replace "Community Time" with "Dev Weekends".',
        ].join('\n'),
      },
    ],
    expectProposal: true,
    check: (r, blocks) => {
      const final = applyInMemory(blocks, r);
      const ids = touchedIds(r, blocks);
      const untouchable = [
        ...idsOf(blocks, 'Work'),
        ...idsOf(blocks, 'LeafCompute'),
      ];
      const communityLeft = final.filter((b) => b.title === 'Community Time');
      const devWeekends = final.filter((b) => /dev weekends/i.test(b.title));
      const study = final.filter((b) => /^study$/i.test(b.title.trim()));
      const bookLeft = final.filter((b) => b.title === 'Book');
      const labs = final.filter(
        (b) => b.id.startsWith('new-') && /lab|soft/i.test(b.title),
      );
      const core = onDays(final, /core engineering/i, [2, 4]);
      return [
        ...fail(
          untouchable.some((id) => ids.has(id)),
          'touches Work or LeafCompute, which the user said stay',
        ),
        ...fail(
          communityLeft.length > 0,
          `${communityLeft.length} Community Time block(s) were not renamed (weekdays and weekends both asked for)`,
        ),
        ...fail(
          devWeekends.length < 7,
          `expected Dev Weekends on all 7 days, found ${devWeekends.length}`,
        ),
        ...fail(
          bookLeft.length > 0 || study.length < 4,
          'Book is not renamed to Study on all four days',
        ),
        ...fail(
          !/(3|three)[ -]hours?/i.test(r.prose) ||
            !/(2|two)[ -]hours?|work/i.test(r.prose),
          'does not flag that Book is 2 hours and 3 hours runs into Work',
        ),
        ...fail(
          core.length < 2,
          'Reading & Labs is not kept as Core Engineering on Tue and Thu',
        ),
        ...fail(
          labs.length < 4,
          `expected 2 labs on each of Tue and Thu, found ${labs.length}`,
        ),
        ...fail(
          labs.some(
            (b) => !insideSlot(b, '07:00', '09:00') || minutes(b) !== 30,
          ),
          'a lab is not a 30-minute block inside the 7:00 to 9:00 AM slot',
        ),
        ...fail(
          claimsBulletsInsideBlock(r.prose),
          'claims to store the lab topics inside a block',
        ),
        ...fail(
          !/leafcompute|(don'?t|do not|can'?t|cannot) (see|find)|no block|not (a|an existing) block|isn'?t a block|doesn'?t exist/i.test(
            r.prose,
          ),
          'does not say "Talking About Weekdays" is not a block (5 PM is LeafCompute)',
        ),
      ];
    },
  },
  {
    id: 'move-into-conflict',
    description:
      'Move a block into an occupied slot: resolve the conflict or ask, never emit a refused card',
    blocks: REAL_WEEK,
    turns: [{ role: 'user', content: 'move Tech Podcast on Sunday to 1pm' }],
    expectProposal: 'either',
    check: (r) =>
      fail(
        allActions(r).length === 0 && !/career strategy/i.test(r.prose),
        'neither proposes a resolution nor names the block in the way (Career Strategy and Applications)',
      ),
  },
  {
    id: 'swap-two-blocks',
    description: 'Swap two blocks on one day',
    blocks: REAL_WEEK,
    turns: [
      { role: 'user', content: 'on Tuesday swap Book and Reading & Labs' },
    ],
    expectProposal: true,
    check: (r, blocks) => {
      const final = applyInMemory(blocks, r);
      const tueBook = final.find(
        (b) => b.dayOfWeek === 2 && b.title === 'Book',
      );
      const tueReading = final.find(
        (b) => b.dayOfWeek === 2 && /Reading & Labs/.test(b.title),
      );
      return fail(
        !(tueBook?.startTime === '07:00' && tueReading?.startTime === '09:00'),
        'Tuesday does not end with Book at 7:00 AM and Reading & Labs at 9:00 AM',
      );
    },
  },
  {
    id: 'free-up-saturday-afternoon',
    description: 'Range request: free up Saturday afternoon',
    blocks: REAL_WEEK,
    turns: [
      {
        role: 'user',
        content: 'free up my saturday afternoon, delete whatever is there',
      },
    ],
    expectProposal: true,
    check: (r, blocks) => {
      const deletes = allActions(r)
        .filter((a) => a.type === 'DELETE_SCHEDULE_BLOCK')
        .map((a) => a.id);
      const branding = idsOf(blocks, 'Branding and Great Content')[0];
      const morning = idsOf(blocks, 'Deep Reading', [6])[0];
      return [
        ...fail(
          !deletes.includes(branding),
          'does not delete Branding and Great Content (1:00 to 3:00 PM)',
        ),
        ...fail(deletes.includes(morning), 'deletes a morning block'),
      ];
    },
  },
  {
    id: 'past-midnight',
    description: 'Impossible as stated: a block that crosses midnight',
    blocks: REAL_WEEK,
    turns: [
      { role: 'user', content: 'add Late Study on Friday from 11pm to 1am' },
    ],
    expectProposal: 'either',
    check: (r) =>
      fail(
        allActions(r).length === 0 && !/midnight/i.test(r.prose),
        'neither splits the block at midnight nor explains why it cannot cross midnight',
      ),
  },
  {
    id: 'times-24h-format',
    description: 'Times given in 24-hour format',
    blocks: REAL_WEEK,
    turns: [{ role: 'user', content: 'add Gym on monday from 20:00 to 21:00' }],
    expectProposal: true,
    check: (r, blocks) => {
      const gym = applyInMemory(blocks, r).filter((b) => /gym/i.test(b.title));
      return fail(
        !(
          gym.length === 1 &&
          gym[0].dayOfWeek === 1 &&
          gym[0].startTime === '20:00' &&
          gym[0].endTime === '21:00'
        ),
        'does not create exactly Gym Mon 20:00 to 21:00',
      );
    },
  },
  {
    id: 'relative-time-after-work',
    description:
      'Relative time: "after Work" when the slot right after Work is taken',
    blocks: REAL_WEEK,
    turns: [
      {
        role: 'user',
        content: 'add a 30 minute walk right after Work on Wednesday',
      },
    ],
    expectProposal: 'either',
    check: (r) =>
      fail(
        allActions(r).length === 0 &&
          !/community time|4:00 ?PM|4 ?PM/i.test(r.prose),
        'neither proposes a valid slot nor explains that Community Time follows Work',
      ),
  },
  {
    id: 'delete-one-of-same-name',
    description:
      'Delete by name when several blocks share it and another is similar',
    blocks: REAL_WEEK,
    turns: [{ role: 'user', content: 'delete Family Time on Monday morning' }],
    expectProposal: true,
    check: (r, blocks) => {
      const deletes = allActions(r)
        .filter((a) => a.type === 'DELETE_SCHEDULE_BLOCK')
        .map((a) => a.id);
      const target = idsOf(blocks, 'Family Time', [1])[0];
      return [
        ...fail(
          deletes.length !== 1 || deletes[0] !== target,
          'does not delete exactly Monday 5:00 AM Family Time',
        ),
      ];
    },
  },
  {
    id: 'correction-all-days',
    description:
      'User corrects the Coach mid-conversation: "do it on all the days it is on"',
    blocks: REAL_WEEK,
    turns: [
      {
        role: 'user',
        content:
          'rename Reading & Labs (Core Engineering) on Tuesday to Core Engineering',
      },
      {
        role: 'assistant',
        content: `Done as a card.\n\n\`\`\`coach-proposal\n{"summary":"Rename Tuesday Reading & Labs","actions":[{"type":"UPDATE_SCHEDULE_BLOCK","id":"${idsOf(REAL_WEEK, READING, [2])[0]}","expectedTitle":"${READING}","payload":{"title":"Core Engineering"}}]}\n\`\`\``,
      },
      { role: 'user', content: 'no, do it on every day it is on' },
    ],
    expectProposal: true,
    check: (r, blocks) => {
      const ids = touchedIds(r, blocks);
      return fail(
        !readingIds.every((id) => ids.has(id)),
        'does not rename both Tuesday and Thursday',
      );
    },
  },
  {
    id: 'no-free-slot',
    description:
      'Impossible: three free hours on Saturday morning that do not exist',
    blocks: REAL_WEEK,
    turns: [
      {
        role: 'user',
        content: 'add a 3 hour Side Project block on Saturday morning',
      },
    ],
    expectProposal: 'either',
    check: (r) =>
      fail(
        allActions(r).length === 0 && !/deep reading/i.test(r.prose),
        'neither proposes making room nor says Deep Reading fills Saturday morning',
      ),
  },
  {
    id: 'rename-every-day',
    description: 'Large batch: rename a block that runs every day (7 updates)',
    blocks: REAL_WEEK,
    turns: [
      {
        role: 'user',
        content: 'rename every Community Time block to Dev Weekends',
      },
    ],
    expectProposal: true,
    check: (r, blocks) => {
      const final = applyInMemory(blocks, r);
      return fail(
        final.filter((b) => b.title === 'Community Time').length > 0,
        'leaves some Community Time blocks unrenamed',
      );
    },
  },
];
