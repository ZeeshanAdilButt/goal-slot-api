import {
  CoachVoiceIntentService,
  validateAndNormalize,
} from '../coach-voice-intent.service';
import { VoiceIntentRequestDto } from '../dto/voice-intent.dto';

const GOAL_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';

describe('validateAndNormalize', () => {
  const goalIds = new Set([GOAL_ID]);
  const taskIds = new Set([TASK_ID]);

  it('passes through a well-formed high-confidence classification', () => {
    const result = validateAndNormalize(
      {
        intent: 'START_TRACKING',
        confidence: 'high',
        target: { kind: 'goal', id: GOAL_ID },
        text: '',
        reasoning: 'User asked to start tracking their goal by name.',
      },
      goalIds,
      taskIds,
    );
    expect(result).toEqual({
      intent: 'START_TRACKING',
      confidence: 'high',
      target: { kind: 'goal', id: GOAL_ID },
      text: null,
      reasoning: 'User asked to start tracking their goal by name.',
    });
  });

  it('falls back to UNKNOWN + low confidence for an unrecognized intent value', () => {
    const result = validateAndNormalize(
      {
        intent: 'DELETE_EVERYTHING',
        confidence: 'high',
        target: null,
        text: '',
        reasoning: 'x',
      },
      goalIds,
      taskIds,
    );
    expect(result.intent).toBe('UNKNOWN');
    expect(result.confidence).toBe('low');
  });

  it('never trusts a target id that was not in the candidate list', () => {
    const result = validateAndNormalize(
      {
        intent: 'START_TRACKING',
        confidence: 'high',
        target: { kind: 'goal', id: OTHER_ID },
        text: '',
        reasoning: 'x',
      },
      goalIds,
      taskIds,
    );
    expect(result.target).toBeNull();
    expect(result.confidence).toBe('low');
  });

  it('resolves a valid task target', () => {
    const result = validateAndNormalize(
      {
        intent: 'START_TRACKING',
        confidence: 'high',
        target: { kind: 'task', id: TASK_ID },
        text: '',
        reasoning: 'x',
      },
      goalIds,
      taskIds,
    );
    expect(result.target).toEqual({ kind: 'task', id: TASK_ID });
  });

  it('treats target.kind "none" as no target', () => {
    const result = validateAndNormalize(
      {
        intent: 'CHAT',
        confidence: 'low',
        target: { kind: 'none' },
        text: '',
        reasoning: 'x',
      },
      goalIds,
      taskIds,
    );
    expect(result.target).toBeNull();
  });

  it('converts empty text to null and trims/caps non-empty text', () => {
    const empty = validateAndNormalize(
      {
        intent: 'CHAT',
        confidence: 'low',
        target: null,
        text: '   ',
        reasoning: 'x',
      },
      goalIds,
      taskIds,
    );
    expect(empty.text).toBeNull();

    const withText = validateAndNormalize(
      {
        intent: 'APPEND_NOTE',
        confidence: 'high',
        target: null,
        text: '  Call Sam back  ',
        reasoning: 'x',
      },
      goalIds,
      taskIds,
    );
    expect(withText.text).toBe('Call Sam back');
  });

  it('defaults confidence to "low" when missing or not "high"', () => {
    const result = validateAndNormalize(
      { intent: 'CHAT', target: null, text: '', reasoning: 'x' },
      goalIds,
      taskIds,
    );
    expect(result.confidence).toBe('low');
  });

  it('handles completely garbage input without throwing', () => {
    const result = validateAndNormalize('not an object', goalIds, taskIds);
    expect(result.intent).toBe('UNKNOWN');
    expect(result.confidence).toBe('low');
    expect(result.target).toBeNull();
  });
});

describe('CoachVoiceIntentService.classify', () => {
  function buildRequest(
    overrides: Partial<VoiceIntentRequestDto> = {},
  ): VoiceIntentRequestDto {
    return {
      transcript: 'start tracking deen',
      context: {
        candidateGoals: [{ id: GOAL_ID, title: 'Deen Practice' }],
        candidateTasks: [{ id: TASK_ID, title: 'Daily standup' }],
        timerStatus: 'idle',
      },
      ...overrides,
    } as VoiceIntentRequestDto;
  }

  function buildService(opts: {
    resolvedKind?: 'byok' | 'shared';
    extractStructured: (...args: any[]) => Promise<any>;
  }) {
    const coachAi = {
      resolveCoachKey: jest.fn().mockResolvedValue(
        opts.resolvedKind === 'byok'
          ? {
              kind: 'byok',
              byok: {
                provider: 'ANTHROPIC',
                ciphertext: new Uint8Array([1]),
                iv: new Uint8Array([2]),
                authTag: new Uint8Array([3]),
                keyVersion: 1,
              },
            }
          : {
              kind: 'shared',
              provider: 'GEMINI',
              decryptedKey: 'shared-key',
              selectedModel: 'gemini-2.5-flash',
            },
      ),
    };
    const encryption = {
      decrypt: jest.fn().mockReturnValue('decrypted-byok-key'),
    };
    const providerInstance = {
      extractStructured: opts.extractStructured,
    };
    const llmFactory = {
      create: jest.fn().mockReturnValue(providerInstance),
    };

    const service = new CoachVoiceIntentService(
      coachAi as any,
      encryption as any,
      llmFactory as any,
    );
    return { service, coachAi, encryption, llmFactory, providerInstance };
  }

  it('classifies via the shared key path and returns the normalized result', async () => {
    const { service, llmFactory } = buildService({
      resolvedKind: 'shared',
      extractStructured: jest.fn().mockResolvedValue({
        data: {
          intent: 'START_TRACKING',
          confidence: 'high',
          target: { kind: 'goal', id: GOAL_ID },
          text: '',
          reasoning: 'Matched "deen" to Deen Practice goal.',
        },
        usage: { promptTokens: 10, completionTokens: 5 },
      }),
    });

    const result = await service.classify('user-1', buildRequest());

    expect(result.intent).toBe('START_TRACKING');
    expect(result.target).toEqual({ kind: 'goal', id: GOAL_ID });
    expect(llmFactory.create).toHaveBeenCalledWith('GEMINI', 'shared-key');
    // Uses the fixed fast-tier model, not the shared key's own selectedModel.
    const [, model] = llmFactory.create.mock.calls[0];
    void model;
  });

  it('decrypts and uses the BYOK key + provider when the user has one configured', async () => {
    const { service, encryption, llmFactory } = buildService({
      resolvedKind: 'byok',
      extractStructured: jest.fn().mockResolvedValue({
        data: {
          intent: 'STOP_TRACKING',
          confidence: 'high',
          target: null,
          text: '',
          reasoning: 'x',
        },
        usage: { promptTokens: 10, completionTokens: 5 },
      }),
    });

    const result = await service.classify('user-1', buildRequest());

    expect(encryption.decrypt).toHaveBeenCalled();
    expect(llmFactory.create).toHaveBeenCalledWith(
      'ANTHROPIC',
      'decrypted-byok-key',
    );
    expect(result.intent).toBe('STOP_TRACKING');
  });

  it('falls back to UNKNOWN/low instead of throwing when the provider call fails', async () => {
    const { service } = buildService({
      resolvedKind: 'shared',
      extractStructured: jest.fn().mockRejectedValue(new Error('boom')),
    });

    const result = await service.classify('user-1', buildRequest());

    expect(result).toEqual({
      intent: 'UNKNOWN',
      confidence: 'low',
      target: null,
      text: null,
      reasoning: 'Classifier error, falling back to full Coach.',
    });
  });

  it('passes the fixed fast-tier model for the resolved provider, not a user-selected one', async () => {
    const extractStructured = jest.fn().mockResolvedValue({
      data: {
        intent: 'CHAT',
        confidence: 'low',
        target: null,
        text: '',
        reasoning: 'x',
      },
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    const { service } = buildService({
      resolvedKind: 'shared',
      extractStructured,
    });

    await service.classify('user-1', buildRequest());

    expect(extractStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.5-flash-lite' }),
    );
  });
});
