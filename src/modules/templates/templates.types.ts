// Curated community templates. Each template is a self-contained JSON-shaped
// definition that the import endpoint can materialize into the user's account.
// Categories drive filtering on the web Library page. A template is allowed
// to belong to multiple categories.

export type TemplateCategory =
  | 'schedule'
  | 'habits'
  | 'goals'
  | 'notes'
  | 'journal';

export interface TemplateScheduleBlock {
  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  dayOfWeek: number;
  // "HH:mm" 24-hour, must be < endTime
  startTime: string;
  endTime: string;
  title: string;
  // Optional. Resolves to a real Goal id at import time if the user opts to
  // create goals; if they imported schedule only, the block is created without
  // a goal link.
  goalRef?: string;
  // Free-text category reference, optional.
  category?: string;
}

export interface TemplateGoal {
  // Local id within this template only. Used by blocks and tasks to point
  // back. Never persisted.
  ref: string;
  title: string;
  description?: string;
  category?: string;
  color: string;
  // Explicit target for the goal's progress meter, in hours. If omitted the
  // service derives a weekly estimate from schedule block coverage, but for
  // multi-month sized goals (e.g. "300 LeetCode problems in 4 months") set
  // this directly so the meter is calibrated.
  targetHours?: number;
}

export interface TemplateTask {
  // If set, links to a TemplateGoal.ref. If the user is creating goals on
  // import, the resolved Goal id goes on the task; otherwise the task is
  // created unlinked.
  goalRef?: string;
  title: string;
  description?: string;
  category?: string;
}

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  // Long-form pitch that lives on the detail page. Markdown allowed.
  longDescription?: string;
  source: string;
  sourceUrl?: string;
  featured: boolean;
  categories: TemplateCategory[];
  // Optional sections. A template may ship only goals + tasks (a "goal pack")
  // or only schedule blocks (a "schedule template"), or all three.
  schedule?: TemplateScheduleBlock[];
  goals?: TemplateGoal[];
  tasks?: TemplateTask[];
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  source: string;
  featured: boolean;
  categories: TemplateCategory[];
  blockCount: number;
  goalCount: number;
  taskCount: number;
}

export interface TemplateImportOptions {
  schedule: boolean;
  goals: boolean;
  tasks: boolean;
  // When true, the service deletes the user's existing schedule blocks,
  // goals, and tasks for whichever sections are being imported, BEFORE
  // creating the new rows. Used for the "I imported, do not like it, let
  // me retry" flow. Destructive; the dialog confirms first.
  replaceExisting?: boolean;
}

export interface TemplateImportResult {
  templateId: string;
  goalsCreated: number;
  scheduleBlocksCreated: number;
  tasksCreated: number;
}
