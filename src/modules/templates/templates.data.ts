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

const WEEKDAY_SHAPE: BlockShape[] = [
  { startTime: '03:30', endTime: '04:00', title: 'Wake Up + Gratitude + Cold Shower', goalRef: 'health' },
  { startTime: '04:00', endTime: '05:00', title: 'Fajr + Quran (translation, recitation, Arabic)', goalRef: 'spiritual' },
  { startTime: '05:00', endTime: '09:00', title: 'Deep Focus: DSA + Intermittent Fasting', goalRef: 'tech' },
  { startTime: '09:00', endTime: '09:30', title: 'Breakfast + Mind Talk', goalRef: 'health' },
  { startTime: '09:30', endTime: '13:00', title: 'Tech Learning Block 1', goalRef: 'tech' },
  { startTime: '13:00', endTime: '13:15', title: 'Dhuhr + 15-min Walk in Sunlight', goalRef: 'spiritual' },
  { startTime: '13:15', endTime: '13:45', title: 'Lunch + Tech Talk', goalRef: 'tech' },
  { startTime: '13:45', endTime: '17:00', title: 'Tech Learning Block 2', goalRef: 'tech' },
  { startTime: '17:00', endTime: '18:00', title: 'Asr + Maghrib + Family Time', goalRef: 'family' },
  { startTime: '18:00', endTime: '18:30', title: 'Dinner + Deen Talk', goalRef: 'family' },
  { startTime: '18:30', endTime: '19:00', title: 'Isha + Talk to Allah', goalRef: 'spiritual' },
  { startTime: '19:00', endTime: '19:30', title: 'Sleep Like a Baby (wind down)', goalRef: 'health' },
];

const WEEKEND_SHAPE: BlockShape[] = [
  { startTime: '03:30', endTime: '04:00', title: 'Wake Up + Gratitude + Cold Shower', goalRef: 'health' },
  { startTime: '04:00', endTime: '05:00', title: 'Fajr + Dhikr + Quran', goalRef: 'spiritual' },
  { startTime: '05:00', endTime: '08:00', title: 'Personal Time / DSA Revision', goalRef: 'tech' },
  { startTime: '08:00', endTime: '08:30', title: 'Breakfast + Mind Talk', goalRef: 'health' },
  { startTime: '08:30', endTime: '13:00', title: 'Tech Grind Block 1', goalRef: 'tech' },
  { startTime: '13:00', endTime: '13:15', title: 'Dhuhr + 15-min Walk in Sunlight', goalRef: 'spiritual' },
  { startTime: '13:15', endTime: '13:45', title: 'Lunch + Tech Talk', goalRef: 'tech' },
  { startTime: '13:45', endTime: '15:30', title: 'Tech Grind Block 2', goalRef: 'tech' },
  { startTime: '15:30', endTime: '17:00', title: 'Asr + Maghrib + Family Time', goalRef: 'family' },
  { startTime: '17:00', endTime: '18:00', title: 'Dinner + Deen Talk', goalRef: 'family' },
  { startTime: '18:00', endTime: '18:30', title: 'Isha + Talk to Allah', goalRef: 'spiritual' },
  { startTime: '18:30', endTime: '19:00', title: 'Sleep Like a Baby (wind down)', goalRef: 'health' },
];

const DEV_WEEKENDS_WINNER_STUDY: TemplateDefinition = {
  id: 'dev-weekends-winner-study-2024',
  name: 'Winner Study Schedule by Dev Weekends',
  source: 'Dev Weekends',
  description:
    'A spiritually-grounded, tech-grind schedule from the Dev Weekends community. Early start, deep focus, balanced with worship, family time, and recovery. Use it as-is or customize after import.',
  longDescription: `
This is the original "Winner Study Schedule" template shared inside the Dev Weekends community in August 2024. The shape is intentional:

- **Early start (3:30 AM)** so the deepest focus block lands before the world wakes up.
- **Prayer anchors the day** at Fajr, Dhuhr, Asr/Maghrib, and Isha, with the schedule built around them rather than the other way around.
- **Two large tech-learning blocks** sandwich Dhuhr, with a real lunch and a short tech-talk in between. Total weekday tech volume is ~7 hours.
- **Hard stop at 7 PM** for sleep so the early wake actually works.
- **Weekends** swap the morning DSA block for personal time, then pivot to a longer "Tech Grind" with the rest of the day mirroring the weekday rhythm.

When you import, you can pull in the full schedule, plus four implicit goals (Tech Mastery, Spiritual Growth, Health & Body, Family & Relationships) and a starter set of tasks under each. All three are optional checkboxes — pick what you want.
`.trim(),
  featured: true,
  categories: ['schedule', 'habits', 'goals'],

  goals: [
    {
      ref: 'tech',
      title: 'Tech Mastery',
      description:
        'Daily DSA, structured tech learning, contributing to open source, and tech talks during lunch. The compounding loop that makes the schedule worth waking up for.',
      category: 'WORK',
      color: '#0ea5e9',
    },
    {
      ref: 'spiritual',
      title: 'Spiritual Growth',
      description:
        'Prayer anchors (Fajr, Dhuhr, Asr, Maghrib, Isha), daily Quran with translation, Arabic study, Tafseer, and weekly Deen talks at dinner.',
      category: 'PERSONAL',
      color: '#8b5cf6',
    },
    {
      ref: 'health',
      title: 'Health & Body',
      description:
        'Cold showers, intermittent fasting, the 15-minute walk in sunlight after Dhuhr, and a non-negotiable 7 PM bedtime to support the 3:30 AM wake.',
      category: 'PERSONAL',
      color: '#10b981',
    },
    {
      ref: 'family',
      title: 'Family & Relationships',
      description:
        'Dedicated family time after Asr, shared dinner with Deen talk, and intentional conversations with parents and siblings about life, deen, and growth.',
      category: 'PERSONAL',
      color: '#f59e0b',
    },
  ],

  schedule: [
    ...blocksForDays(WEEKDAY_SHAPE, MON_TO_FRI),
    ...blocksForDays(WEEKEND_SHAPE, SAT_SUN),
  ],

  tasks: [
    // Tech
    { goalRef: 'tech', title: 'Solve 2 LeetCode problems daily (string / array / DP rotation)' },
    { goalRef: 'tech', title: 'Complete 2 hours of FreeCodeCamp REACT lectures' },
    { goalRef: 'tech', title: 'Complete 2 hours of Udemy AWS / Design Patterns / DevOps / MERN' },
    { goalRef: 'tech', title: 'Contribute to one open-source repo this week' },
    { goalRef: 'tech', title: 'Watch one tech talk during lunch (NDC, GOTO, "Day in life @ Google")' },
    { goalRef: 'tech', title: 'Enter one weekend contest (AtCoder, Codeforces)' },

    // Spiritual
    { goalRef: 'spiritual', title: 'Read Quran with translation daily (start: 45-day target)' },
    { goalRef: 'spiritual', title: 'Tafseer study (start: 90-day target)' },
    { goalRef: 'spiritual', title: 'Learn one new Dua per week and add it to morning practice' },
    { goalRef: 'spiritual', title: 'Begin a 60-day Arabic learning challenge' },
    { goalRef: 'spiritual', title: 'Watch one Sahaba / Quranic Gems / Omer Soleman talk per evening' },

    // Health
    { goalRef: 'health', title: 'Cold shower every morning before Fajr' },
    { goalRef: 'health', title: 'Intermittent fasting window: water + light snack until 9 AM' },
    { goalRef: 'health', title: '15-minute walk in sunlight right after Dhuhr' },
    { goalRef: 'health', title: 'Lights out by 7 PM. No exceptions.' },

    // Family
    { goalRef: 'family', title: 'Daily intentional conversation with a parent or sibling' },
    { goalRef: 'family', title: 'Family dinner together with a Deen / life topic on the table' },
    { goalRef: 'family', title: 'One game (chess, etc.) with a younger sibling each week' },
  ],
};

export const APPROVED_TEMPLATES: TemplateDefinition[] = [
  DEV_WEEKENDS_WINNER_STUDY,
];
