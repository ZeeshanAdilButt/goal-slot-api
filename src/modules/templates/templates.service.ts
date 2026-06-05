import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { APPROVED_TEMPLATES } from './templates.data';
import {
  TemplateDefinition,
  TemplateImportOptions,
  TemplateImportResult,
  TemplateSummary,
} from './templates.types';

// Maps a template's local `goalRef` strings to the real Goal ids we created.
type GoalRefMap = Map<string, string>;

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
            },
            select: { id: true },
          });
          goalRefMap.set(g.ref, created.id);
          goalsCreated++;
        }
      }

      if (opts.schedule && template.schedule?.length) {
        // Generate a single seriesId per (goalRef, title, startTime, endTime,
        // dayOfWeek-set) combo so blocks the user later wants to bulk-edit
        // stay grouped. For simplicity v1 assigns one seriesId per template
        // import per (title + startTime + endTime); blocks with the same
        // shape across multiple days will share the series.
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
}
