import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TasksService } from './tasks.service';
import { UpdateTaskDto } from './dto/tasks.dto';

// Regression cover for "a task's due date can never be removed".
//
// `update` built its data as `dueDate: dto.dueDate ? new Date(dto.dueDate) :
// undefined`, and that explicit key overrode the `...updateData` spread. So an
// explicit `null` — the only way a client can express "clear this" — collapsed
// to `undefined`, which Prisma reads as "leave unchanged". Combined with
// `UpdateTaskDto` having no null-accepting validator, there was NO payload
// shape that could unset a due date once one was set.
//
// That mattered because the Coach could attach a due date the user never
// asked for (CREATE_TASK's prompt entry did not tell the model to omit it),
// and the user then had no way to take it off short of deleting the task.

const USER = 'user-id';
const TASK = 'task-id';

class FakePrisma {
  updateCalls: any[] = [];

  task = {
    findFirst: async ({ where }: any) =>
      where.id === TASK && where.userId === USER
        ? { id: TASK, userId: USER, title: 'Call the Bank' }
        : null,
    update: async (args: any) => {
      this.updateCalls.push(args);
      return { id: TASK, ...args.data };
    },
  };
}

function makeService() {
  const prisma = new FakePrisma();
  const service = new TasksService(
    prisma as any,
    {} as any, // authService — untouched by update()
    {} as any, // goalsService — untouched by update()
  );
  return { prisma, service };
}

describe('TasksService.update dueDate', () => {
  it('clears the stored due date when given an explicit null', async () => {
    const { prisma, service } = makeService();

    await service.update(USER, TASK, { dueDate: null } as any);

    expect(prisma.updateCalls).toHaveLength(1);
    // `null`, not `undefined` — the latter is Prisma's "leave unchanged".
    expect(prisma.updateCalls[0].data.dueDate).toBeNull();
  });

  it('sets the due date when given a date string', async () => {
    const { prisma, service } = makeService();

    await service.update(USER, TASK, { dueDate: '2026-08-20' } as any);

    expect(prisma.updateCalls[0].data.dueDate).toEqual(new Date('2026-08-20'));
  });

  it('leaves the due date untouched when the key is absent', async () => {
    const { prisma, service } = makeService();

    await service.update(USER, TASK, { title: 'Renamed' } as any);

    expect(prisma.updateCalls[0].data.dueDate).toBeUndefined();
    expect('dueDate' in prisma.updateCalls[0].data).toBe(true);
  });
});

describe('UpdateTaskDto dueDate validation', () => {
  async function errorsFor(payload: Record<string, unknown>) {
    return validate(plainToInstance(UpdateTaskDto, payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  }

  it('accepts an explicit null so a client can ask to clear the date', async () => {
    expect(await errorsFor({ dueDate: null })).toHaveLength(0);
  });

  it('accepts an omitted dueDate', async () => {
    expect(await errorsFor({ title: 'Call the Bank' })).toHaveLength(0);
  });

  it('accepts a bare calendar day and a full ISO instant', async () => {
    expect(await errorsFor({ dueDate: '2026-08-20' })).toHaveLength(0);
    expect(
      await errorsFor({ dueDate: '2026-08-20T00:00:00.000Z' }),
    ).toHaveLength(0);
  });

  // Loosening the validator to allow null must not let prose through — these
  // are the shapes a model improvises when a prompt doesn't demand ISO-8601.
  it('still rejects unparseable values', async () => {
    for (const value of ['today', 'tomorrow', 'ASAP', '', '08/20/2026']) {
      expect(await errorsFor({ dueDate: value })).not.toHaveLength(0);
    }
  });
});
