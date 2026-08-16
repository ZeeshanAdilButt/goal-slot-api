import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /coach/chat/:scopeKey/messages/:messageId/save.
 *
 * Every other Coach endpoint validates its body against a decorated DTO
 * through the global ValidationPipe; this one previously typed its body as
 * a bare `{ title?: string }` interface. The ValidationPipe only validates
 * and transforms declared *classes* (it inspects `metatype` and skips
 * plain object/interface types), so that inline type was never actually
 * enforced at the HTTP boundary — a caller could send `title` as a number,
 * array, or object.
 *
 * `CoachAiService.saveChatMessageAsInsight` does defensively call
 * `.slice(0, 100)` on the value, which happens to exist on both String and
 * Array prototypes but not on Number/Boolean/plain-object, and a non-string
 * survivor (e.g. an array) would then be handed to Prisma as `title`, which
 * expects a String column. Either path is an unhandled 500 from a single
 * malformed request rather than a clean 400. Declaring a real DTO here
 * closes that gap the same way `ChatMessageDto` does for chat content.
 */
export class SaveInsightTitleDto {
  @ApiPropertyOptional({
    description:
      'Optional title override for the saved insight. Falls back to the first sentence of the Coach reply, capped at 100 chars, when omitted.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;
}
