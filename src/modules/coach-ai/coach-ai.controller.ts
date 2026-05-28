import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Query,
  Request,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CoachAiService } from './coach-ai.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { UserThrottlerGuard } from './user-throttler.guard';

// 30 calls per rolling 24 hours, per user.
const COACH_TTL_MS = 86_400_000;
const COACH_LIMIT = 30;

interface SsePayload {
  delta: string;
  done: boolean;
  error?: string;
}

@ApiTags('coach-ai')
@Controller('coach')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachAiController {
  constructor(private readonly coachAi: CoachAiService) {}

  @Get('narrative/:scopeKey')
  @ApiOperation({ summary: 'Get the cached weekly narrative or 404' })
  async getNarrative(
    @Request() req: any,
    @Param('scopeKey') scopeKey: string,
  ) {
    return this.coachAi.getLatestNarrative(req.user.sub, scopeKey);
  }

  @Post('narrative/:scopeKey')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ 'coach-ai': { limit: COACH_LIMIT, ttl: COACH_TTL_MS } })
  @Sse()
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('X-Accel-Buffering', 'no')
  @Header('Connection', 'keep-alive')
  @ApiOperation({ summary: 'Stream the weekly narrative via SSE' })
  streamNarrative(
    @Request() req: any,
    @Param('scopeKey') scopeKey: string,
    @Query('force') force?: string,
  ): Observable<MessageEvent> {
    const wantForce = force === 'true' || force === '1';
    const iter = this.coachAi.streamNarrative(
      req.user.sub,
      scopeKey,
      wantForce,
    );
    return asSseObservable(iter);
  }

  @Get('chat/:scopeKey')
  @ApiOperation({ summary: 'Get chat history for the scope' })
  async getChatHistory(
    @Request() req: any,
    @Param('scopeKey') scopeKey: string,
  ) {
    return this.coachAi.getChatHistory(req.user.sub, scopeKey);
  }

  @Post('chat/:scopeKey')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ 'coach-ai': { limit: COACH_LIMIT, ttl: COACH_TTL_MS } })
  @Sse()
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('X-Accel-Buffering', 'no')
  @Header('Connection', 'keep-alive')
  @ApiOperation({ summary: 'Stream a chat reply via SSE' })
  streamChat(
    @Request() req: any,
    @Param('scopeKey') scopeKey: string,
    @Body() body: ChatMessageDto,
  ): Observable<MessageEvent> {
    const iter = this.coachAi.streamChatReply(
      req.user.sub,
      scopeKey,
      body.content,
    );
    return asSseObservable(iter);
  }

  @Delete('chat/:scopeKey')
  @ApiOperation({
    summary:
      'Clear the chat history for this scope so the next message starts fresh. Accepted insights + narrative stay; only chat messages + the chat conversation row are removed.',
  })
  async clearChat(
    @Request() req: any,
    @Param('scopeKey') scopeKey: string,
  ): Promise<{ success: true }> {
    await this.coachAi.clearChat(req.user.sub, scopeKey);
    return { success: true };
  }
}

/**
 * Bridge an async iterator of `{ delta, done }` payloads to an RxJS
 * Observable<MessageEvent> the `@Sse()` decorator expects. Errors from
 * the generator (HttpException, etc.) are caught and emitted as a final
 * SSE event `{ data: { error, done: true } }` so the client always gets
 * a clean terminal frame.
 */
function asSseObservable(
  iter: AsyncGenerator<SsePayload>,
): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    let cancelled = false;
    (async () => {
      try {
        for await (const payload of iter) {
          if (cancelled) break;
          subscriber.next({ data: payload } as MessageEvent);
          if (payload.done) break;
        }
        subscriber.complete();
      } catch (err: any) {
        const message =
          err?.response?.message ??
          err?.message ??
          'Internal error during streaming';
        // For non-HttpException errors we still emit a terminal event so the
        // client UI can render gracefully rather than just losing the stream.
        try {
          subscriber.next({
            data: { delta: '', done: true, error: String(message) },
          } as MessageEvent);
        } catch {
          /* subscriber may already be closed */
        }
        subscriber.complete();
      }
    })();
    return () => {
      cancelled = true;
    };
  });
}
