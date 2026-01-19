import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { PostHog } from 'posthog-node'

@Injectable()
export class PostHogService implements OnModuleDestroy {
  private posthog: PostHog

  constructor() {
    this.posthog = new PostHog(process.env.POSTHOG_API_KEY!, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt: 20, // Batch events and send when 20 are queued
      flushInterval: 10000, // Or send every 10 seconds
    })
  }

  /**
   * Get the PostHog instance
   */
  getInstance(): PostHog {
    return this.posthog
  }

  /**
   * Capture an event
   */
  capture(distinctId: string, event: string, properties?: Record<string, any>) {
    this.posthog.capture({
      distinctId,
      event,
      properties,
    })
  }

  /**
   * Identify a user
   */
  identify(distinctId: string, properties?: Record<string, any>) {
    this.posthog.identify({
      distinctId,
      properties,
    })
  }

  /**
   * Capture an exception
   */
  captureException(error: Error, distinctId?: string, properties?: Record<string, any>) {
    const exceptionData: any = {
      $exception_message: error.message,
      $exception_type: error.constructor.name,
      ...properties,
    }

    if (distinctId) {
      exceptionData.distinctId = distinctId
    }

    this.posthog.captureException(error, exceptionData)
  }

  /**
   * Set user properties
   */
  setUserProperties(distinctId: string, properties: Record<string, any>) {
    this.posthog.identify({
      distinctId,
      properties,
    })
  }

  /**
   * Flush pending events (useful before shutdown)
   */
  async flush() {
    await this.posthog.shutdown()
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy() {
    await this.flush()
  }
}
