// A single delivery channel a reminder can go out through. Each channel
// (email, web push, Expo push) implements this the same way, so the
// dispatcher can run all of them without knowing which ones exist.
export interface ReminderChannel {
  readonly name: string;

  send(input: ReminderChannelInput): Promise<ReminderChannelResult>;
}

export interface ReminderChannelInput {
  userId: string;
  title: string;
  body: string;
  // Carries enough context for the client to route a tap somewhere specific,
  // e.g. { type: 'schedule', sharedAccessId } or { type: 'instruction', instructionId }.
  data?: Record<string, unknown>;
}

export interface ReminderChannelResult {
  ok: boolean;
  // Set when the channel confirms the underlying subscription/token is dead
  // (a web push 410, an Expo DeviceNotRegistered ticket) so the caller knows
  // to stop retrying it. Omitted or false otherwise.
  subscriptionGone?: boolean;
}

// Multi-provider injection token: RemindersModule collects every registered
// ReminderChannel provider under this token and hands the array to
// ReminderDispatchService, so adding a new channel later means adding one
// provider, not editing the dispatcher.
export const REMINDER_CHANNELS = 'REMINDER_CHANNELS';
