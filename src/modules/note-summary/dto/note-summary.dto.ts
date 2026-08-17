import { ApiProperty } from '@nestjs/swagger';

/**
 * Response of POST /notes/:id/summary.
 *
 * Returns the CREATED note rather than just its content, so the client can put
 * it straight into its cache and navigate to it without a second round trip —
 * the summary is a real page from the moment this responds, not a draft the
 * client then has to save.
 */
export class NoteSummaryResponseDto {
  @ApiProperty({ description: 'The newly created summary note.' })
  note: {
    id: string;
    title: string;
    content: string;
    parentId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };

  @ApiProperty({
    description:
      'Id of the note that was summarized. The summary is created as its child.',
  })
  sourceNoteId: string;
}
