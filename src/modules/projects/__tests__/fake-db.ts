/* eslint-disable @typescript-eslint/no-explicit-any */
// Test-only helper (not a *.spec.ts file, so the spec override in
// .eslintrc.js does not reach it). Prisma-shaped fakes need `any` for the
// same reason the specs do.
import { Prisma } from '@prisma/client';

/**
 * A small in-memory stand-in for the Prisma client, shared by the Projects
 * specs. It evaluates `where` filters (scalars, in/not/gt/gte/lt/lte, OR/AND,
 * one-to-one `is`, one-to-many `some`) and honours `include`/`select`
 * (including filtered nested relations and `_count`) so the specs exercise
 * the services' real queries instead of asserting on recorded arguments.
 *
 * Every model name works: unknown tables start empty, so a service that
 * reads something the spec did not seed simply gets nothing back.
 */

type Row = Record<string, any>;

type Relation =
  | { kind: 'one'; model: string; fk: string }
  | { kind: 'many'; model: string; fk: string };

const RELATIONS: Record<string, Record<string, Relation>> = {
  task: {
    user: { kind: 'one', model: 'user', fk: 'userId' },
    project: { kind: 'one', model: 'project', fk: 'projectId' },
    assignee: { kind: 'one', model: 'user', fk: 'assigneeId' },
    goal: { kind: 'one', model: 'goal', fk: 'goalId' },
    scheduleBlock: {
      kind: 'one',
      model: 'scheduleBlock',
      fk: 'scheduleBlockId',
    },
    timeEntries: { kind: 'many', model: 'timeEntry', fk: 'taskId' },
  },
  project: {
    members: { kind: 'many', model: 'projectMember', fk: 'projectId' },
    invites: { kind: 'many', model: 'projectInvite', fk: 'projectId' },
    tasks: { kind: 'many', model: 'task', fk: 'projectId' },
    createdBy: { kind: 'one', model: 'user', fk: 'createdById' },
  },
  projectMember: {
    project: { kind: 'one', model: 'project', fk: 'projectId' },
    user: { kind: 'one', model: 'user', fk: 'userId' },
  },
  projectInvite: {
    project: { kind: 'one', model: 'project', fk: 'projectId' },
    invitedBy: { kind: 'one', model: 'user', fk: 'invitedById' },
  },
  timeEntry: {
    goal: { kind: 'one', model: 'goal', fk: 'goalId' },
    task: { kind: 'one', model: 'task', fk: 'taskId' },
    scheduleBlock: {
      kind: 'one',
      model: 'scheduleBlock',
      fk: 'scheduleBlockId',
    },
  },
  activeTimerSession: {
    goal: { kind: 'one', model: 'goal', fk: 'goalId' },
    task: { kind: 'one', model: 'task', fk: 'taskId' },
    scheduleBlock: {
      kind: 'one',
      model: 'scheduleBlock',
      fk: 'scheduleBlockId',
    },
  },
};

const DEFAULTS: Record<string, () => Row> = {
  task: () => ({
    status: 'BACKLOG',
    order: 0,
    projectId: null,
    assigneeId: null,
    goalId: null,
    scheduleBlockId: null,
    dueDate: null,
    completedAt: null,
    actualMinutes: null,
  }),
  project: () => ({ color: '#2563EB', description: null, archivedAt: null }),
  projectMember: () => ({ role: 'MEMBER', joinedAt: new Date() }),
  projectInvite: () => ({ role: 'MEMBER', acceptedAt: null, revokedAt: null }),
  timeEntry: () => ({
    goalId: null,
    taskId: null,
    scheduleBlockId: null,
    source: 'MANUAL',
  }),
};

// Compound unique keys used with findUnique / update / delete.
const COMPOUND: Record<string, Record<string, string[]>> = {
  projectMember: { projectId_userId: ['projectId', 'userId'] },
};

const UNIQUE: Record<string, string[][]> = {
  projectMember: [['projectId', 'userId']],
  projectInvite: [['token']],
};

function isPlainObject(v: unknown): v is Row {
  return (
    typeof v === 'object' &&
    v !== null &&
    !(v instanceof Date) &&
    !Array.isArray(v)
  );
}

function cmp(a: any, b: any): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  return x < y ? -1 : 1;
}

function eq(a: any, b: any, insensitive = false): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined))
    return true;
  if (a instanceof Date || b instanceof Date) return cmp(a, b) === 0;
  if (insensitive && typeof a === 'string' && typeof b === 'string')
    return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

let seq = 0;
const newId = (model: string) => `${model}-${++seq}`;

export class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every call, for the few tests that need to look at query shape. */
  calls: Array<{ model: string; op: string; args: any }> = [];

  private table(model: string): Row[] {
    return (this.tables[model] ??= []);
  }

  seed(model: string, row: Row): Row {
    const full = {
      id: newId(model),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(DEFAULTS[model]?.() ?? {}),
      ...row,
    };
    this.table(model).push(full);
    return full;
  }

  // ---------------- where ----------------

  matches(model: string, row: Row | null | undefined, where: any): boolean {
    if (!where) return true;
    if (!row) return false;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === 'OR') {
        if (!(cond as any[]).some((w) => this.matches(model, row, w)))
          return false;
        continue;
      }
      if (key === 'AND') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((w) => this.matches(model, row, w))) return false;
        continue;
      }
      if (key === 'NOT') {
        if (this.matches(model, row, cond)) return false;
        continue;
      }
      const compound = COMPOUND[model]?.[key];
      if (compound) {
        if (!compound.every((f) => eq(row[f], (cond as any)[f]))) return false;
        continue;
      }
      const rel = RELATIONS[model]?.[key];
      if (rel) {
        if (!this.matchRelation(model, row, rel, cond)) return false;
        continue;
      }
      if (!this.matchScalar(row[key], cond)) return false;
    }
    return true;
  }

  private matchRelation(_model: string, row: Row, rel: Relation, cond: any) {
    if (rel.kind === 'one') {
      const target =
        row[rel.fk] == null
          ? null
          : (this.table(rel.model).find((r) => r.id === row[rel.fk]) ?? null);
      if (cond === null) return target === null;
      if (isPlainObject(cond) && 'is' in cond) {
        if (cond.is === null) return target === null;
        return target !== null && this.matches(rel.model, target, cond.is);
      }
      if (isPlainObject(cond) && 'isNot' in cond) {
        if (cond.isNot === null) return target !== null;
        return target === null || !this.matches(rel.model, target, cond.isNot);
      }
      return target !== null && this.matches(rel.model, target, cond);
    }
    const children = this.table(rel.model).filter((r) => r[rel.fk] === row.id);
    if (cond.some)
      return children.some((c) => this.matches(rel.model, c, cond.some));
    if (cond.every)
      return children.every((c) => this.matches(rel.model, c, cond.every));
    if (cond.none)
      return !children.some((c) => this.matches(rel.model, c, cond.none));
    return true;
  }

  private matchScalar(value: any, cond: any): boolean {
    if (!isPlainObject(cond)) return eq(value, cond);
    const insensitive = cond.mode === 'insensitive';
    for (const [op, arg] of Object.entries(cond)) {
      if (arg === undefined || op === 'mode') continue;
      switch (op) {
        case 'equals':
          if (!eq(value, arg, insensitive)) return false;
          break;
        case 'in':
          if (!(arg as any[]).some((a) => eq(value, a, insensitive)))
            return false;
          break;
        case 'notIn':
          if ((arg as any[]).some((a) => eq(value, a, insensitive)))
            return false;
          break;
        case 'not':
          if (isPlainObject(arg)) {
            if (this.matchScalar(value, arg)) return false;
          } else if (eq(value, arg, insensitive)) return false;
          break;
        case 'gt':
          if (value == null || cmp(value, arg) <= 0) return false;
          break;
        case 'gte':
          if (value == null || cmp(value, arg) < 0) return false;
          break;
        case 'lt':
          if (value == null || cmp(value, arg) >= 0) return false;
          break;
        case 'lte':
          if (value == null || cmp(value, arg) > 0) return false;
          break;
        default:
          throw new Error(`FakeDb: unsupported scalar filter ${op}`);
      }
    }
    return true;
  }

  // ---------------- shape ----------------

  private shape(model: string, row: Row, args: any): Row {
    if (!args?.select && !args?.include) return { ...row };
    const out: Row = args.select ? {} : { ...row };
    const spec = args.select ?? args.include;
    for (const [key, val] of Object.entries(spec)) {
      if (!val) continue;
      if (key === '_count') {
        out._count = this.count(model, row, (val as any).select);
        continue;
      }
      const rel = RELATIONS[model]?.[key];
      if (!rel) {
        out[key] = row[key];
        continue;
      }
      const sub = val === true ? {} : (val as any);
      if (rel.kind === 'one') {
        const target =
          row[rel.fk] == null
            ? null
            : (this.table(rel.model).find((r) => r.id === row[rel.fk]) ?? null);
        out[key] = target ? this.shape(rel.model, target, sub) : null;
      } else {
        let children = this.table(rel.model).filter(
          (r) => r[rel.fk] === row.id && this.matches(rel.model, r, sub.where),
        );
        children = this.order(children, sub.orderBy);
        if (typeof sub.take === 'number')
          children = children.slice(0, sub.take);
        out[key] = children.map((c) => this.shape(rel.model, c, sub));
      }
    }
    return out;
  }

  private count(model: string, row: Row, select: any): Row {
    const out: Row = {};
    for (const [key, val] of Object.entries(select ?? {})) {
      const rel = RELATIONS[model]?.[key];
      if (!rel || rel.kind !== 'many') continue;
      const where = val === true ? undefined : (val as any).where;
      out[key] = this.table(rel.model).filter(
        (r) => r[rel.fk] === row.id && this.matches(rel.model, r, where),
      ).length;
    }
    return out;
  }

  private order(rows: Row[], orderBy: any): Row[] {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) =>
      Object.entries(o).filter(([, dir]) => typeof dir === 'string'),
    ) as Array<[string, 'asc' | 'desc']>;
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const c = cmp(a[k], b[k]);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  private assertUnique(model: string, row: Row, ignoreId?: string) {
    for (const fields of UNIQUE[model] ?? []) {
      const clash = this.table(model).find(
        (r) => r.id !== ignoreId && fields.every((f) => eq(r[f], row[f])),
      );
      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: 'fake',
        });
      }
    }
  }

  private applyData(model: string, row: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (RELATIONS[model]?.[k]) continue; // nested writes handled by create
      row[k] = v;
    }
    row.updatedAt = new Date();
  }

  // ---------------- model delegates ----------------

  model(model: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    const record = (op: string, args: any) =>
      db.calls.push({ model, op, args });
    const find = (where: any) =>
      db.table(model).filter((r) => db.matches(model, r, where));

    return {
      findUnique: async (args: any) => {
        record('findUnique', args);
        const row = find(args.where)[0];
        return row ? db.shape(model, row, args) : null;
      },
      findFirst: async (args: any = {}) => {
        record('findFirst', args);
        const row = db.order(find(args.where), args.orderBy)[0];
        return row ? db.shape(model, row, args) : null;
      },
      findMany: async (args: any = {}) => {
        record('findMany', args);
        let rows = db.order(find(args.where), args.orderBy);
        if (typeof args.take === 'number') rows = rows.slice(0, args.take);
        return rows.map((r) => db.shape(model, r, args));
      },
      count: async (args: any = {}) => {
        record('count', args);
        return find(args.where).length;
      },
      create: async (args: any) => {
        record('create', args);
        const { data } = args;
        const row: Row = {
          id: data.id ?? newId(model),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(DEFAULTS[model]?.() ?? {}),
        };
        db.applyData(model, row, data);
        db.assertUnique(model, row);
        db.table(model).push(row);
        // Nested `relation: { create: {...} }` for one-to-many relations.
        for (const [k, v] of Object.entries(data)) {
          const rel = RELATIONS[model]?.[k];
          if (rel?.kind === 'many' && (v as any)?.create) {
            const items = Array.isArray((v as any).create)
              ? (v as any).create
              : [(v as any).create];
            for (const item of items) {
              await db.model(rel.model).create({
                data: { ...item, [rel.fk]: row.id },
              });
            }
          }
        }
        return db.shape(model, row, args);
      },
      createMany: async (args: any) => {
        record('createMany', args);
        for (const data of args.data) await db.model(model).create({ data });
        return { count: args.data.length };
      },
      update: async (args: any) => {
        record('update', args);
        const row = find(args.where)[0];
        if (!row) throw new Error(`FakeDb: ${model}.update found no row`);
        db.applyData(model, row, args.data);
        db.assertUnique(model, row, row.id);
        return db.shape(model, row, args);
      },
      updateMany: async (args: any) => {
        record('updateMany', args);
        const rows = find(args.where);
        for (const row of rows) db.applyData(model, row, args.data);
        return { count: rows.length };
      },
      delete: async (args: any) => {
        record('delete', args);
        const row = find(args.where)[0];
        if (!row) throw new Error(`FakeDb: ${model}.delete found no row`);
        db.removeCascade(model, row);
        return row;
      },
      deleteMany: async (args: any = {}) => {
        record('deleteMany', args);
        const rows = find(args.where);
        for (const row of rows) db.removeCascade(model, row);
        return { count: rows.length };
      },
      upsert: async (args: any) => {
        record('upsert', args);
        const row = find(args.where)[0];
        if (row) {
          db.applyData(model, row, args.update);
          return db.shape(model, row, args);
        }
        return db
          .model(model)
          .create({ data: args.create, include: args.include });
      },
      aggregate: async (args: any) => {
        record('aggregate', args);
        const rows = find(args.where);
        const out: Row = {};
        if (args._sum) {
          out._sum = {};
          for (const f of Object.keys(args._sum)) {
            out._sum[f] = rows.length
              ? rows.reduce((s, r) => s + (r[f] ?? 0), 0)
              : null;
          }
        }
        if (args._max) {
          out._max = {};
          for (const f of Object.keys(args._max)) {
            out._max[f] = rows.length
              ? rows.reduce((m, r) => (m === null || r[f] > m ? r[f] : m), null)
              : null;
          }
        }
        if (args._count) out._count = rows.length;
        return out;
      },
      groupBy: async (args: any) => {
        record('groupBy', args);
        const groups = new Map<string, Row[]>();
        for (const r of find(args.where)) {
          const key = JSON.stringify(args.by.map((f: string) => r[f] ?? null));
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        return [...groups.entries()].map(([key, rows]) => {
          const values = JSON.parse(key);
          const out: Row = {};
          args.by.forEach((f: string, i: number) => (out[f] = values[i]));
          if (args._sum) {
            out._sum = {};
            for (const f of Object.keys(args._sum))
              out._sum[f] = rows.reduce((s, r) => s + (r[f] ?? 0), 0);
          }
          return out;
        });
      },
    };
  }

  /** Mirrors the schema's onDelete rules for the models these specs use. */
  private removeCascade(model: string, row: Row) {
    this.tables[model] = this.table(model).filter((r) => r !== row);
    if (model === 'project') {
      for (const child of ['projectMember', 'projectInvite', 'task']) {
        for (const c of this.table(child).filter((r) => r.projectId === row.id))
          this.removeCascade(child, c);
      }
    }
    if (model === 'task') {
      for (const e of this.table('timeEntry'))
        if (e.taskId === row.id) e.taskId = null;
    }
  }

  $transaction = async (arg: any) => {
    if (typeof arg === 'function') return arg(this.client);
    return Promise.all(arg);
  };

  /** The object handed to services as `PrismaService`. */
  client: any = new Proxy(this, {
    get(target, prop: string) {
      if (prop === '$transaction') return target.$transaction;
      if (typeof prop !== 'string' || prop.startsWith('$') || prop === 'then')
        return undefined;
      return target.model(prop);
    },
  });
}
