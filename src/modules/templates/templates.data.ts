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

  tasks: [
    // ----- Cracking DSA: weekly cadence + milestones -----
    { goalRef: 'dsa', title: 'This week: 15 LeetCode problems (rotate string / array / hash map)' },
    { goalRef: 'dsa', title: 'Milestone 1: 50 problems solved (easy strings + arrays)' },
    { goalRef: 'dsa', title: 'Milestone 2: 100 problems solved (add hash maps + two pointers)' },
    { goalRef: 'dsa', title: 'Milestone 3: 150 problems solved (add dynamic programming + graphs)' },
    { goalRef: 'dsa', title: 'Milestone 4: 200+ problems solved (goal complete)' },
    { goalRef: 'dsa', title: 'Weekly weekend contest (AtCoder or Codeforces)' },

    // ----- Cracking Tech: 4 mega projects + curriculum stepping -----
    {
      goalRef: 'tech',
      title: 'Mega Project 1 of 4: Real Estate Marketplace (Weeks 5-7)',
      description:
        'Modern MERN with JWT + Redux Toolkit. https://youtu.be/VAaUy_Moivw . End with a 1-page case study.',
    },
    {
      goalRef: 'tech',
      title: 'Mega Project 2 of 4: Grocery Delivery or Hotel Booking (Weeks 8-10)',
      description:
        'Grocery: https://youtu.be/PaQX0pktLnw . Hotel: https://youtu.be/ubM9cX8G_gk . Pick one, ship it.',
    },
    {
      goalRef: 'tech',
      title: 'Mega Project 3 of 4: School Management or Movie Ticket (Weeks 11-13)',
      description:
        'School Management is the recommended intermediate option. Movie Ticket: https://www.youtube.com/watch?v=Pez37wmUaQM .',
    },
    {
      goalRef: 'tech',
      title: 'Mega Project 4 of 4: Multi-Vendor MERN E-commerce + case study (Weeks 14-17)',
      description:
        'The capstone. Reference: https://drive.google.com/drive/folders/1VMYrWmM_WZNsfjOiMBkNU1M-JKUPAidc . Case study template: https://docs.google.com/document/d/14rKVfuyAj6exQCTdvm_ioThmAbxAnpxNuDQ3oMlU6lY .',
    },
    {
      goalRef: 'tech',
      title: 'Foundations Week 1-2: HTML + CSS (positioning, flexbox) + CSS Grid',
      description:
        'CSS: https://www.youtube.com/watch?v=K1naz9wBwKU . Grid: https://www.youtube.com/watch?v=9zBsdzdE4sM .',
    },
    {
      goalRef: 'tech',
      title: 'Foundations Week 3-4: JavaScript basics through advanced (DW playlist videos 1-51)',
      description:
        'https://www.youtube.com/watch?v=Hr5iLG7sUa0&list=PLu71SKxNbfoBuX3f4EOACle2y-tRC5Q37 .',
    },
    {
      goalRef: 'tech',
      title: 'Foundations Week 5: Git + GitHub fundamentals',
    },
    {
      goalRef: 'tech',
      title: 'Foundations Week 6: freeCodeCamp JavaScript Algorithms + DSA certificate',
      description: 'https://www.freecodecamp.org/learn/javascript-algorithms-and-data-structures (10-15 hours).',
    },
    {
      goalRef: 'tech',
      title: 'React Weeks 7-9: Master Class + first hooks projects (Tour site, Weather, Food Recipe)',
      description:
        'Master Class: https://www.youtube.com/playlist?list=PLSsAz5wf2lkKm0BG9wUWWSgYWBzDa-dFs . Projects: https://youtu.be/5ZdHfJVAY-s .',
    },
    {
      goalRef: 'tech',
      title: 'Node Weeks 10-12: freeCodeCamp Node + Express + MongoDB + MERN CRUD',
      description:
        'Node L0: https://www.youtube.com/watch?v=ohIAiuHMKMI . MERN CRUD: https://youtu.be/enOsPhp2Z6Q .',
    },
    { goalRef: 'tech', title: 'Stretch: DW DevOps series, pick 4-5 videos from L0 + L1' },
    { goalRef: 'tech', title: 'Stretch: TypeScript foundations + apply to one existing project' },
    { goalRef: 'tech', title: 'Stretch: Next.js (only after 4-5 multi-vendor-level projects)' },
    { goalRef: 'tech', title: 'Stretch: Prisma in one MERN project' },

    // ----- Cracking Mindset: weekly cadence + featured picks + Book of the Month -----
    { goalRef: 'mindset', title: 'This week: 5 mindset talks over breakfast' },
    {
      goalRef: 'mindset',
      title: 'Book of the Month: Atomic Habits by James Clear',
      description:
        'An easy and proven way to build good habits and break bad ones. Read one chapter per day, capture one applicable idea each time.',
    },
    { goalRef: 'mindset', title: 'Talk of the Week: Build a Mind So Strong It Scares People' },
    { goalRef: 'mindset', title: 'Talk of the Month: Bodybuilding for the Brain' },
    {
      goalRef: 'mindset',
      title: 'Watch: Junior Developers are Dead!',
      description: 'https://www.youtube.com/watch?v=H7-qkU1SC9M',
    },
    { goalRef: 'mindset', title: 'Watch: The Power of Morning Routines' },
    { goalRef: 'mindset', title: 'Watch: Exploring Life, Faith and Self (MindMaster Fridays EP 01)' },
    { goalRef: 'mindset', title: 'Watch: One Hour a Day Can Change Your Life' },
    { goalRef: 'mindset', title: 'Watch: How to Achieve Your Most Ambitious Goals' },
    { goalRef: 'mindset', title: 'Watch: The Puzzle of Motivation (Dan Pink, TED)' },
    { goalRef: 'mindset', title: 'Watch: The Purpose of Life' },
    { goalRef: 'mindset', title: 'Watch: Types of Hearts' },
    { goalRef: 'mindset', title: 'Capture one applicable insight per talk in the journal' },

    // ----- Engineering Mastery: weekly cadence + featured shows -----
    { goalRef: 'engineering', title: 'This week: 5 engineering talks at lunch' },
    { goalRef: 'engineering', title: 'Watch: Node.js Documentary' },
    { goalRef: 'engineering', title: 'Watch: Hussein Nasser Backend Engineering Show (one episode per week)' },
    { goalRef: 'engineering', title: 'Watch: NDC Conferences (rotating picks)' },
    { goalRef: 'engineering', title: 'Watch: GOTO Conferences (rotating picks)' },
    { goalRef: 'engineering', title: 'Watch: Day in life @ Google / Amazon / Meta' },
    { goalRef: 'engineering', title: 'Write a one-paragraph takeaway after each talk' },

    // ----- Spiritual Growth: weekly cadence + featured talks + daily practice -----
    { goalRef: 'spiritual', title: 'This week: 5 spiritual talks at dinner' },
    { goalRef: 'spiritual', title: 'Watch: A Life of Khushu' },
    { goalRef: 'spiritual', title: 'Watch: Quranic Gems by Nouman Ali Khan (one episode per week)' },
    { goalRef: 'spiritual', title: 'Watch: Sahaba Series by Omar Suleiman' },
    { goalRef: 'spiritual', title: 'Daily sacred reading with translation' },
    { goalRef: 'spiritual', title: 'Weekly tafseer / commentary study (90-day target)' },

    // ----- Amazing Family Relationships -----
    { goalRef: 'family', title: 'Daily intentional conversation with a parent or sibling' },
    { goalRef: 'family', title: 'Family dinner together with a life / reflection topic on the table' },
    { goalRef: 'family', title: 'Weekly: one small thing (chess, walk, side project) with a younger sibling' },
    { goalRef: 'family', title: 'Monthly: a thoughtful message or letter to a family member you do not see often' },

    // ----- 100 Days of Gratitude (morning entry + discipline streaks) -----
    { goalRef: 'gratitude', title: 'Daily morning: write 3 things you are grateful for' },
    { goalRef: 'gratitude', title: '100-day streak: cold shower every morning' },
    { goalRef: 'gratitude', title: '100-day streak: intermittent fasting window (water + light snack until 9 AM)' },
    { goalRef: 'gratitude', title: '100-day streak: lights out by 7 PM, no exceptions' },

    // ----- 100 Days of Writing (midday walk thoughts + evening reflection) -----
    { goalRef: 'writing', title: 'Daily midday: capture one thought during the sunlight walk' },
    { goalRef: 'writing', title: 'Daily evening: write today\'s wins, lessons, and intent for tomorrow' },
    { goalRef: 'writing', title: 'Weekly: re-read the week\'s entries and pull out one pattern' },
  ],
};

export const APPROVED_TEMPLATES: TemplateDefinition[] = [
  DEV_WEEKENDS_WINNER_STUDY,
];
