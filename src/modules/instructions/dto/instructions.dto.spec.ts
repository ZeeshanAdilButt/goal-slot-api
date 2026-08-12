import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssignInstructionDto } from './instructions.dto';

// title/note are free text set by any assigner with an accepted share and
// flow unescaped-length into reminder emails two days later - capping the
// length keeps a single instruction from blowing up the rendered email
// (and matches the pattern of every other user-supplied text field in
// this API having a bound).
describe('AssignInstructionDto', () => {
  async function validateDto(payload: Partial<AssignInstructionDto>) {
    const dto = plainToInstance(AssignInstructionDto, payload);
    return validate(dto);
  }

  it('accepts a title and note within the length cap', async () => {
    const errors = await validateDto({
      assigneeId: 'user_1',
      title: 'Log time daily this week',
      note: 'Even a rough estimate is fine.',
    });

    expect(errors).toHaveLength(0);
  });

  it('rejects a title longer than 200 characters', async () => {
    const errors = await validateDto({
      assigneeId: 'user_1',
      title: 'x'.repeat(201),
    });

    expect(errors.some((e) => e.property === 'title')).toBe(true);
  });

  it('rejects a note longer than 200 characters', async () => {
    const errors = await validateDto({
      assigneeId: 'user_1',
      title: 'Log time daily this week',
      note: 'x'.repeat(201),
    });

    expect(errors.some((e) => e.property === 'note')).toBe(true);
  });
});
