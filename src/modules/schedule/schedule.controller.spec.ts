import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ScheduleController } from './schedule.controller';
import { SetScheduleBlockDaysDto } from './dto/schedule.dto';

// POST /schedule/:id/days takes the same ValidationPipe the app registers
// globally in main.ts, so the body is checked here with that exact config.
const pipe = new ValidationPipe({ whitelist: true, transform: true });

const validate = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: SetScheduleBlockDaysDto,
  }) as Promise<SetScheduleBlockDaysDto>;

describe('SetScheduleBlockDaysDto validation', () => {
  it('accepts a list of unique weekdays', async () => {
    const dto = await validate({ days: [1, 3, 5] });
    expect(dto.days).toEqual([1, 3, 5]);
  });

  it('accepts a single day and all seven days', async () => {
    await expect(validate({ days: [0] })).resolves.toBeTruthy();
    await expect(
      validate({ days: [0, 1, 2, 3, 4, 5, 6] }),
    ).resolves.toBeTruthy();
  });

  it('strips unknown properties (whitelist)', async () => {
    const dto = await validate({ days: [1], seriesId: 'x', userId: 'y' });
    expect(dto).toEqual({ days: [1] });
  });

  it.each([
    ['an empty list', { days: [] }],
    ['a missing days field', {}],
    ['days that is not an array', { days: 3 }],
    ['a day below 0', { days: [-1] }],
    ['a day above 6', { days: [1, 7] }],
    ['duplicate days', { days: [1, 1] }],
    ['a non-integer day', { days: [1.5] }],
    ['a numeric string', { days: ['1'] }],
    ['null entries', { days: [null] }],
    ['more than seven days', { days: [0, 1, 2, 3, 4, 5, 6, 0] }],
  ])('rejects %s with a 400', async (_label, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ScheduleController.setDays', () => {
  it('passes the caller, block id and days to the service', async () => {
    const result = { blocks: [], added: [3], removed: [] };
    const service = { setSeriesDays: jest.fn().mockResolvedValue(result) };
    const controller = new ScheduleController(service as any);

    const out = await controller.setDays(
      { user: { sub: 'user-1' } } as any,
      'block-1',
      { days: [1, 3] },
    );

    expect(service.setSeriesDays).toHaveBeenCalledWith(
      'user-1',
      'block-1',
      [1, 3],
    );
    expect(out).toBe(result);
  });
});
