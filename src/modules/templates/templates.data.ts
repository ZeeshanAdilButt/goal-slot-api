import {
  TemplateDefinition,
  TemplateScheduleBlock,
} from './templates.types';

type BlockShape = Omit<TemplateScheduleBlock, 'dayOfWeek'>;

// Helper to fan a single weekday/weekend shape into multiple dayOfWeek values.
// Keeps the schedule definition below readable instead of repeating each
// block five (or two) times by hand.
function blocksForDays(
  shape: BlockShape[],
  days: number[],
): TemplateScheduleBlock[] {
  const out: TemplateScheduleBlock[] = [];
  for (const day of days) {
    for (const b of shape) {
      out.push({ ...b, dayOfWeek: day });
    }
  }
  return out;
}

const MON_TO_FRI = [1, 2, 3, 4, 5];
const SAT_SUN = [6, 0];

// Phrasing is intentionally neutral so the schedule fits anyone. The five
// "rhythm pauses" through the day (dawn, midday, late afternoon, sunset,
// evening) map cleanly to the five Muslim daily prayers for users who want
// to read them that way; the template does not assume anyone else has to.
const WEEKDAY_SHAPE: BlockShape[] = [
  { startTime: '03:30', endTime: '04:00', title: 'Wake Up + Gratitude + Cold Shower', goalRef: 'gratitude' },
  { startTime: '04:00', endTime: '05:00', title: 'Dawn Practice + Sacred Reading', goalRef: 'spiritual' },
  { startTime: '05:00', endTime: '09:00', title: 'Deep Focus: DSA + Problem Solving (Intermittent Fasting)', goalRef: 'dsa' },
  { startTime: '09:00', endTime: '09:30', title: 'Breakfast + Mindset Talk', goalRef: 'mindset' },
  { startTime: '09:30', endTime: '13:00', title: 'Tech Learning Block 1 (Course / Track)', goalRef: 'tech' },
  { startTime: '13:00', endTime: '13:15', title: 'Midday Pause + 15-min Walk in Sunlight', goalRef: 'writing' },
  { startTime: '13:15', endTime: '13:45', title: 'Lunch + Engineering Conversation', goalRef: 'engineering' },
  { startTime: '13:45', endTime: '17:00', title: 'Tech Learning Block 2 (Project Work)', goalRef: 'tech' },
  { startTime: '17:00', endTime: '18:00', title: 'Late Afternoon Pause + Family Time', goalRef: 'family' },
  { startTime: '18:00', endTime: '18:30', title: 'Dinner + Reflection Talk', goalRef: 'spiritual' },
  { startTime: '18:30', endTime: '19:00', title: 'Evening Reflection + Writing Thoughts', goalRef: 'writing' },
  { startTime: '19:00', endTime: '19:30', title: 'Sleep Like a Baby (wind down)', goalRef: 'gratitude' },
];

const WEEKEND_SHAPE: BlockShape[] = [
  { startTime: '03:30', endTime: '04:00', title: 'Wake Up + Gratitude + Cold Shower', goalRef: 'gratitude' },
  { startTime: '04:00', endTime: '05:00', title: 'Dawn Practice + Sacred Reading', goalRef: 'spiritual' },
  { startTime: '05:00', endTime: '08:00', title: 'Personal Time / DSA Revision', goalRef: 'dsa' },
  { startTime: '08:00', endTime: '08:30', title: 'Breakfast + Mindset Talk', goalRef: 'mindset' },
  { startTime: '08:30', endTime: '13:00', title: 'Tech Grind Block 1 (Course / Track)', goalRef: 'tech' },
  { startTime: '13:00', endTime: '13:15', title: 'Midday Pause + 15-min Walk in Sunlight', goalRef: 'writing' },
  { startTime: '13:15', endTime: '13:45', title: 'Lunch + Engineering Conversation', goalRef: 'engineering' },
  { startTime: '13:45', endTime: '15:30', title: 'Tech Grind Block 2 (Project / Open Source)', goalRef: 'tech' },
  { startTime: '15:30', endTime: '17:00', title: 'Late Afternoon Pause + Family Time', goalRef: 'family' },
  { startTime: '17:00', endTime: '18:00', title: 'Dinner + Reflection Talk', goalRef: 'spiritual' },
  { startTime: '18:00', endTime: '18:30', title: 'Evening Reflection + Writing Thoughts', goalRef: 'writing' },
  { startTime: '18:30', endTime: '19:00', title: 'Sleep Like a Baby (wind down)', goalRef: 'gratitude' },
];

const DEV_WEEKENDS_WINNER_STUDY: TemplateDefinition = {
  id: 'dev-weekends-winner-study-2024',
  name: 'Winner Study Schedule by Dev Weekends',
  source: 'Dev Weekends',
  description:
    'A focused, rhythm-anchored schedule from the Dev Weekends community. Early start, deep focus mornings, structured tech learning, and intentional pauses for reflection, family, and recovery. Use it as-is or customize after import.',
  longDescription: `
This is the original Winner Study Schedule template shared inside the Dev Weekends community. The shape is intentional:

- **Early start (3:30 AM)** so the deepest focus block lands before the world wakes up.
- **Five rhythm pauses anchor the day**: dawn, midday, late afternoon, sunset, and evening. The schedule is built around them, not the other way around. (Muslim users will recognise these as Fajr, Dhuhr, Asr, Maghrib, and Isha; the template does not assume anyone else needs to.)
- **Two large tech-learning blocks** sandwich the midday pause. A real lunch and a short engineering conversation in between. Total weekday tech volume is around 7 hours.
- **Hard stop at 7 PM** for sleep so the early wake actually works.
- **Weekends** swap the morning DSA block for personal time, then pivot to a longer Tech Grind with the rest of the day mirroring the weekday rhythm.

When you import, you can pull in the full schedule plus **eight goals** sized for a four-month run:

- **Cracking Tech - 4+ Mega Projects**.
- **Cracking DSA - 200+ Problems**.
- **Cracking Mindset - 50+ Talks** (Talk of the Week, Talk of the Month, and the Book of the Month).
- **Engineering Mastery - 100+ Engineering Talks**.
- **Spiritual Growth - 100+ Spiritual Talks**, with daily sacred reading.
- **Amazing Family Relationships** - sustained, intentional time with parents and siblings.
- **100 Days of Gratitude** - cold shower, fasting, 7 PM bedtime, and the morning gratitude entry. The discipline streaks that make the rest of the schedule possible.
- **100 Days of Writing** - midday walk thoughts and evening reflection writing.

The tasks are sized weekly: **15 LeetCode this week, 5 mindset talks, 5 engineering talks, 5 spiritual talks**, plus the stepped Dev Weekends curriculum that walks you from HTML through a multi-vendor MERN e-commerce project.

All three sections (schedule, goals, tasks) are independent checkboxes on the import dialog. Pick what you want, skip what you do not.
`.trim(),
  featured: true,
  categories: ['schedule', 'habits', 'goals'],

  goals: [
    {
      ref: 'tech',
      title: 'Cracking Tech - 4+ Mega Projects',
      description:
        'Structured Dev Weekends curriculum across the afternoon blocks: HTML → CSS → JS → React → Node + Express + MongoDB → mega projects. Target for the next 4 months is 4+ mega projects shipped, each ending in a written case study.',
      category: 'WORK',
      color: '#0ea5e9',
      targetHours: 320,
    },
    {
      ref: 'dsa',
      title: 'Cracking DSA - 200+ Problems',
      description:
        'Daily DSA / problem solving in the deep-focus morning block. Target for the next 4 months is 200+ LeetCode-style problems solved, rotating across strings, arrays, hash maps, two pointers, dynamic programming, and graphs. Weekend contests count toward the total.',
      category: 'WORK',
      color: '#6366f1',
      targetHours: 100,
    },
    {
      ref: 'mindset',
      title: 'Cracking Mindset - 50+ Talks',
      description:
        'One mindset talk over breakfast, every weekday. Target for the next 4 months is 50+ talks watched (Dan Pink, Atomic Habits, Power of Morning Routines, and the rotating Talk of the Week / Talk of the Month). Track one personal insight per talk in the journal.',
      category: 'PERSONAL',
      color: '#ec4899',
      targetHours: 30,
    },
    {
      ref: 'engineering',
      title: 'Engineering Mastery - 100+ Engineering Talks',
      description:
        'One engineering talk at lunch, every weekday. Target for the next 4 months is 100+ talks watched across NDC, GOTO, Hussein Nasser, the Node.js Documentary, and "Day in life @ Google / Amazon" pieces. Write a one-paragraph takeaway after each.',
      category: 'WORK',
      color: '#06b6d4',
      targetHours: 60,
    },
    {
      ref: 'spiritual',
      title: 'Spiritual Growth - 100+ Spiritual Talks',
      description:
        'Daily sacred reading, the five rhythm pauses through the day, and a reflection talk at dinner. Target for the next 4 months is 100+ spiritual talks watched across the Purpose of Life, Quranic Gems, the Sahaba Series, A Life of Khushu, and the Dev Weekends evening picks.',
      category: 'PERSONAL',
      color: '#8b5cf6',
      targetHours: 60,
    },
    {
      ref: 'family',
      title: 'Amazing Family Relationships',
      description:
        'Dedicated family time in the late afternoon. Shared dinner with a reflection topic on the table. Daily intentional conversation with a parent or sibling. One small thing (chess, walk, side project) with a younger sibling each week.',
      category: 'PERSONAL',
      color: '#f59e0b',
      targetHours: 100,
    },
    {
      ref: 'gratitude',
      title: '100 Days of Gratitude',
      description:
        'Daily morning gratitude entry (three things) right after waking up. The discipline streaks that make the rest of the schedule possible: cold shower, intermittent fasting, 7 PM bedtime. Target: 100 consecutive days.',
      category: 'PERSONAL',
      color: '#10b981',
      targetHours: 15,
    },
    {
      ref: 'writing',
      title: '100 Days of Writing',
      description:
        'Capture one thought during the midday walk in sunlight. Write evening reflection nightly: today\'s wins, lessons, and intent for tomorrow. Target: 100 consecutive days of writing.',
      category: 'PERSONAL',
      color: '#14b8a6',
      targetHours: 15,
    },
  ],

  schedule: [
    ...blocksForDays(WEEKDAY_SHAPE, MON_TO_FRI),
    ...blocksForDays(WEEKEND_SHAPE, SAT_SUN),
  ],

  // Tasks are intentionally vague seeds. They give the user a *sense* of
  // what each goal expects, not a specific answer to follow. Every task
  // title ends in "--placeholder" so the user knows to swap in their own
  // version (their actual problem set, their actual book of the month,
  // their actual project this week).
  tasks: [
    // ----- Cracking DSA: weekly cadence only, two seeds is enough -----
    { goalRef: 'dsa', title: 'This week: solve 15 DSA problems --placeholder' },
    { goalRef: 'dsa', title: 'This week: enter one weekend contest --placeholder' },

    // ----- Cracking Tech -----
    { goalRef: 'tech', title: 'Mega Project 1 of 4 --placeholder' },
    { goalRef: 'tech', title: 'Mega Project 2 of 4 --placeholder' },
    { goalRef: 'tech', title: 'Mega Project 3 of 4 --placeholder' },
    { goalRef: 'tech', title: 'Mega Project 4 of 4 (capstone + case study) --placeholder' },
    { goalRef: 'tech', title: 'Foundations: Frontend basics (HTML, CSS, JS) --placeholder' },
    { goalRef: 'tech', title: 'Foundations: JavaScript deep dive --placeholder' },
    { goalRef: 'tech', title: 'Foundations: Git + GitHub --placeholder' },
    { goalRef: 'tech', title: 'Foundations: DSA certificate --placeholder' },
    { goalRef: 'tech', title: 'React: master class + first hooks projects --placeholder' },
    { goalRef: 'tech', title: 'Backend: Node + Express + MongoDB + MERN CRUD --placeholder' },
    { goalRef: 'tech', title: 'Stretch: pick a DevOps mini-series --placeholder' },
    { goalRef: 'tech', title: 'Stretch: TypeScript --placeholder' },
    { goalRef: 'tech', title: 'Stretch: Next.js --placeholder' },
    { goalRef: 'tech', title: 'Stretch: Prisma --placeholder' },

    // ----- Cracking Mindset (curator-picked talks; cadence + action are placeholders) -----
    { goalRef: 'mindset', title: 'This week: 5 mindset talks at breakfast --placeholder' },
    { goalRef: 'mindset', title: 'Book of the Month: Atomic Habits by James Clear' },
    { goalRef: 'mindset', title: 'Talk of the Week: Build a Mind So Strong It Scares People' },
    { goalRef: 'mindset', title: 'Talk of the Month: Bodybuilding for the Brain' },
    { goalRef: 'mindset', title: 'Watch: Junior Developers are Dead!' },
    { goalRef: 'mindset', title: 'Watch: The Power of Morning Routines' },
    { goalRef: 'mindset', title: 'Watch: Exploring Life, Faith and Self (MindMaster Fridays EP 01)' },
    { goalRef: 'mindset', title: 'Watch: One Hour a Day Can Change Your Life' },
    { goalRef: 'mindset', title: 'Watch: How to Achieve Your Most Ambitious Goals' },
    { goalRef: 'mindset', title: 'Watch: The Puzzle of Motivation (Dan Pink, TED)' },
    { goalRef: 'mindset', title: 'Watch: The Purpose of Life' },
    { goalRef: 'mindset', title: 'Watch: Types of Hearts' },
    { goalRef: 'mindset', title: 'Capture one insight per talk --placeholder' },

    // ----- Engineering Mastery (curator-picked shows; cadence + action are placeholders) -----
    { goalRef: 'engineering', title: 'This week: 5 engineering talks at lunch --placeholder' },
    { goalRef: 'engineering', title: 'Watch: Node.js Documentary' },
    { goalRef: 'engineering', title: 'Watch: Hussein Nasser Backend Engineering Show (one episode per week)' },
    { goalRef: 'engineering', title: 'Watch: NDC Conferences (rotating picks)' },
    { goalRef: 'engineering', title: 'Watch: GOTO Conferences (rotating picks)' },
    { goalRef: 'engineering', title: 'Watch: Day in life @ Google / Amazon / Meta' },
    { goalRef: 'engineering', title: 'Write a one-paragraph takeaway after each talk --placeholder' },

    // ----- Spiritual Growth (curator-picked talks; cadence + daily practice are placeholders) -----
    { goalRef: 'spiritual', title: 'This week: 5 spiritual talks at dinner --placeholder' },
    { goalRef: 'spiritual', title: 'Watch: A Life of Khushu' },
    { goalRef: 'spiritual', title: 'Watch: Quranic Gems by Nouman Ali Khan (one episode per week)' },
    { goalRef: 'spiritual', title: 'Watch: Sahaba Series by Omar Suleiman' },
    { goalRef: 'spiritual', title: 'Daily sacred reading --placeholder' },
    { goalRef: 'spiritual', title: 'Weekly deeper study / commentary --placeholder' },

    // ----- Amazing Family Relationships -----
    { goalRef: 'family', title: 'Daily: one intentional conversation --placeholder' },
    { goalRef: 'family', title: 'Daily family dinner with a topic --placeholder' },
    { goalRef: 'family', title: 'Weekly: a small thing with a younger sibling --placeholder' },
    { goalRef: 'family', title: 'Monthly: a thoughtful message to a family member --placeholder' },

    // ----- 100 Days of Gratitude -----
    { goalRef: 'gratitude', title: 'Daily morning: 3 things grateful for --placeholder' },
    { goalRef: 'gratitude', title: '100-day streak: cold shower --placeholder' },
    { goalRef: 'gratitude', title: '100-day streak: intermittent fasting --placeholder' },
    { goalRef: 'gratitude', title: '100-day streak: 7 PM bedtime --placeholder' },

    // ----- 100 Days of Writing -----
    { goalRef: 'writing', title: 'Daily midday: capture a walk thought --placeholder' },
    { goalRef: 'writing', title: 'Daily evening: reflection writing --placeholder' },
    { goalRef: 'writing', title: 'Weekly: re-read the week\'s entries --placeholder' },
  ],
};

export const APPROVED_TEMPLATES: TemplateDefinition[] = [
  DEV_WEEKENDS_WINNER_STUDY,
];
