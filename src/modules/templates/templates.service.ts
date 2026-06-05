import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { APPROVED_TEMPLATES } from './templates.data';
import {
  TemplateDefinition,
  TemplateImportOptions,
  TemplateImportResult,
  TemplateSummary,
  TemplateTask,
} from './templates.types';

// Maps a template's local `goalRef` strings to the real Goal ids we created.
type GoalRefMap = Map<string, string>;

export interface TemplateSyncResult {
  templateId: string;
  tasksAdded: number;
  skipped: number;
  // True when the user has at least one goal whose templateId matches this
  // template. False means they never imported it and have nothing to sync to.
  matched: boolean;
}

@Injectable()
export class TemplatesService {
  // The browse endpoint returns a summary view so we are not shipping every
  // schedule block to the listing page. Detail view returns the full
  // definition.
  list(): TemplateSummary[] {
    return APPROVED_TEMPLATES.map((t) => this.toSummary(t));
  }

  getOne(id: string): TemplateDefinition {
    const found = APPROVED_TEMPLATES.find((t) => t.id === id);
    if (!found) {
      throw new NotFoundException(`Template ${id} not found`);
    }
    return found;
  }

  // Materialize a template into the user account in a single transaction.
  // Goals are created first because schedule blocks and tasks both reference
  // them. If a section is not requested, we silently skip it and downstream
  // references degrade to null (block with no goalId, task with no goalId).
  async import(
    userId: string,
    templateId: string,
    opts: TemplateImportOptions,
  ): Promise<TemplateImportResult> {
    const template = this.getOne(templateId);

    return await this.prisma.$transaction(async (tx) => {
      const goalRefMap: GoalRefMap = new Map();
      let goalsCreated = 0;
      let scheduleBlocksCreated = 0;
      let tasksCreated = 0;

      // "Replace existing" wipes the user's current rows for whichever
      // sections are being imported. Order matters: tasks and schedule
      // blocks reference goals, so delete them first so goals can be
      // deleted without dangling foreign keys (the relation uses
      // onDelete: SetNull, so the deletes would succeed either way, but
      // doing them in this order is clearer).
      if (opts.replaceExisting) {
        if (opts.tasks) {
          await tx.task.deleteMany({ where: { userId } });
        }
        if (opts.schedule) {
          await tx.scheduleBlock.deleteMany({ where: { userId } });
        }
        if (opts.goals) {
          await tx.goal.deleteMany({ where: { userId } });
        }
      }

      if (opts.goals && template.goals?.length) {
        // The template can pin targetHours explicitly per goal (preferred for
        // multi-month sized goals like "300 LeetCode in 4 months"). When it
        // does not, derive a weekly estimate from schedule block coverage so
        // the meter is at least non-zero from day one.
        const targetHoursByRef = this.computeTargetHoursByRef(template);

        // Use the goal's order in the template as the initial `order` so the
        // goals page shows them in the curator's intended sequence.
        for (let i = 0; i < template.goals.length; i++) {
          const g = template.goals[i];
          const computed = targetHoursByRef.get(g.ref) ?? 0;
          const created = await tx.goal.create({
            data: {
              userId,
              title: g.title,
              description: g.description ?? null,
              category: g.category ?? null,
              color: g.color,
              order: i,
              targetHours: g.targetHours ?? computed,
              templateId: template.id,
              templateGoalRef: g.ref,
            },
            select: { id: true },
          });
          goalRefMap.set(g.ref, created.id);
          goalsCreated++;
        }
      } else if (opts.schedule || opts.tasks) {
        // The user did not opt in to creating goals, but the schedule or
        // tasks they ARE importing reference goalRefs. Pre-populate the map
        // with their existing goals from a prior import of this same
        // template (matched by templateGoalRef) so the new blocks and tasks
        // wire up cleanly. Goals from other templates / hand-created goals
        // do not match.
        const existing = await tx.goal.findMany({
          where: { userId, templateId: template.id },
          select: { id: true, templateGoalRef: true },
        });
        for (const g of existing) {
          if (g.templateGoalRef) goalRefMap.set(g.templateGoalRef, g.id);
        }
      }

      if (opts.schedule && template.schedule?.length) {
        const seriesIdByShape = new Map<string, string>();
        const inputs: Prisma.ScheduleBlockCreateManyInput[] = [];
        for (const b of template.schedule) {
          const shapeKey = `${b.title}|${b.startTime}|${b.endTime}|${b.goalRef ?? ''}`;
          let seriesId = seriesIdByShape.get(shapeKey);
          if (!seriesId) {
            seriesId = crypto.randomUUID();
            seriesIdByShape.set(shapeKey, seriesId);
          }
          inputs.push({
            userId,
            title: b.title,
            startTime: b.startTime,
            endTime: b.endTime,
            dayOfWeek: b.dayOfWeek,
            category: b.category ?? null,
            color: this.colorForBlock(b.goalRef, template),
            isRecurring: true,
            seriesId,
            goalId: b.goalRef ? goalRefMap.get(b.goalRef) ?? null : null,
          });
        }
        const result = await tx.scheduleBlock.createMany({ data: inputs });
        scheduleBlocksCreated = result.count;
      }

      if (opts.tasks && template.tasks?.length) {
        const inputs: Prisma.TaskCreateManyInput[] = template.tasks.map(
          (t, idx) => ({
            userId,
            title: t.title,
            description: t.description ?? null,
            category: t.category ?? null,
            order: idx,
            goalId: t.goalRef ? goalRefMap.get(t.goalRef) ?? null : null,
            templateId: template.id,
            templateTaskKey: this.taskKey(t),
          }),
        );
        const result = await tx.task.createMany({ data: inputs });
        tasksCreated = result.count;
      }

      return {
        templateId: template.id,
        goalsCreated,
        scheduleBlocksCreated,
        tasksCreated,
      };
    });
  }

  // Sync flow: when the curator adds new tasks to a template, users who
  // already imported it can run this to pull the new ones into their
  // account. Dedupe by (userId, templateId, templateTaskKey). Goals are
  // not touched, only tasks; schedule blocks are similarly untouched.
  async syncTasks(
    userId: string,
    templateId: string,
  ): Promise<TemplateSyncResult> {
    const template = this.getOne(templateId);

    return await this.prisma.$transaction(async (tx) => {
      // Map the user's existing goals for this template back to local refs
      // so we know where new tasks should land.
      const existingGoals = await tx.goal.findMany({
        where: { userId, templateId: template.id },
        select: { id: true, templateGoalRef: true },
      });

      if (existingGoals.length === 0) {
        return {
          templateId: template.id,
          tasksAdded: 0,
          skipped: 0,
          matched: false,
        };
      }

      const goalRefMap = new Map<string, string>();
      for (const g of existingGoals) {
        if (g.templateGoalRef) goalRefMap.set(g.templateGoalRef, g.id);
      }

      // Pull every task the user already has from this template (by key).
      const existingKeys = new Set<string>(
        (
          await tx.task.findMany({
            where: { userId, templateId: template.id },
            select: { templateTaskKey: true },
          })
        )
          .map((t) => t.templateTaskKey)
          .filter((k): k is string => !!k),
      );

      // Find template tasks the user does not have yet. Skip tasks whose
      // goalRef does not match any of the user's imported goals (they did
      // not bring that goal in originally, so dropping the task there
      // would be confusing).
      const toAdd: { task: TemplateTask; key: string; goalId: string | null }[] = [];
      let skipped = 0;
      for (const t of template.tasks ?? []) {
        const key = this.taskKey(t);
        if (existingKeys.has(key)) {
          skipped++;
          continue;
        }
        const goalId = t.goalRef ? goalRefMap.get(t.goalRef) ?? null : null;
        if (t.goalRef && !goalId) {
          skipped++;
          continue;
        }
        toAdd.push({ task: t, key, goalId });
      }

      if (toAdd.length === 0) {
        return {
          templateId: template.id,
          tasksAdded: 0,
          skipped,
          matched: true,
        };
      }

      // Append at the end of whatever the user has now.
      const currentMaxOrder = await tx.task.aggregate({
        where: { userId },
        _max: { order: true },
      });
      const startOrder = (currentMaxOrder._max.order ?? -1) + 1;

      await tx.task.createMany({
        data: toAdd.map((entry, idx) => ({
          userId,
          title: entry.task.title,
          description: entry.task.description ?? null,
          category: entry.task.category ?? null,
          order: startOrder + idx,
          goalId: entry.goalId,
          templateId: template.id,
          templateTaskKey: entry.key,
        })),
      });

      return {
        templateId: template.id,
        tasksAdded: toAdd.length,
        skipped,
        matched: true,
      };
    });
  }

  constructor(private readonly prisma: PrismaService) {}

  private toSummary(t: TemplateDefinition): TemplateSummary {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      source: t.source,
      featured: t.featured,
      categories: t.categories,
      blockCount: t.schedule?.length ?? 0,
      goalCount: t.goals?.length ?? 0,
      taskCount: t.tasks?.length ?? 0,
    };
  }

  // Sum hours per week for every block that points at a goal. Schedule blocks
  // are weekly recurring, so weekly hours is also the targetHours the goal
  // page displays.
  private computeTargetHoursByRef(t: TemplateDefinition): Map<string, number> {
    const out = new Map<string, number>();
    if (!t.schedule) return out;
    for (const b of t.schedule) {
      if (!b.goalRef) continue;
      const hours = this.diffHours(b.startTime, b.endTime);
      out.set(b.goalRef, (out.get(b.goalRef) ?? 0) + hours);
    }
    return out;
  }

  private colorForBlock(goalRef: string | undefined, t: TemplateDefinition): string {
    if (!goalRef) return '#FFD700';
    const g = t.goals?.find((g) => g.ref === goalRef);
    return g?.color ?? '#FFD700';
  }

  private diffHours(start: string, end: string): number {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const minutes = (eh - sh) * 60 + (em - sm);
    return Math.max(0, minutes / 60);
  }

  // Stable per-task key for dedup on sync. Either the curator-provided key
  // (preferred) or a slug of the title. Slugs are safe enough as long as
  // the curator avoids renaming an existing task (rename = a "new" task on
  // next sync, which is acceptable for v1).
  private taskKey(t: TemplateTask): string {
    if (t.key && t.key.trim().length > 0) return t.key.trim();
    return t.title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'task';
  }
}
