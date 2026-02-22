import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { PostHog } from 'posthog-node'

@Injectable()
export class PostHogService implements OnModuleDestroy {
  private readonly logger = new Logger(PostHogService.name)
  private posthog: PostHog | null = null

  constructor() {
    const apiKey = process.env.POSTHOG_API_KEY?.trim()
    if (!apiKey) {
      this.logger.warn('POSTHOG_API_KEY is not set. PostHog tracking is disabled.')
      return
    }

    this.posthog = new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt: 20, // Batch events and send when 20 are queued
      flushInterval: 10000, // Or send every 10 seconds
    })
  }

  /**
   * Get the PostHog instance
   */
  getInstance(): PostHog | null {
    return this.posthog
  }

  /**
   * Capture an event
   */
  capture(distinctId: string, event: string, properties?: Record<string, any>) {
    if (!this.posthog) return

    try {
      this.posthog.capture({
        distinctId,
        event,
        properties,
      })
    } catch (error) {
      this.logPostHogError('capture', error)
    }
  }

  /**
   * Identify a user
   */
  identify(distinctId: string, properties?: Record<string, any>) {
    if (!this.posthog) return

    try {
      this.posthog.identify({
        distinctId,
        properties,
      })
    } catch (error) {
      this.logPostHogError('identify', error)
    }
  }

  /**
   * Capture an exception
   */
  captureException(error: unknown, distinctId?: string, properties?: Record<string, any>) {
    if (!this.posthog) return

    try {
      // posthog-node signature: captureException(error, distinctId?, additionalProperties?)
      this.posthog.captureException(error, distinctId, properties)
    } catch (captureError) {
      this.logPostHogError('captureException', captureError)
    }
  }

  /**
   * Set user properties
   */
  setUserProperties(distinctId: string, properties: Record<string, any>) {
    if (!this.posthog) return

    try {
      this.posthog.identify({
        distinctId,
        properties,
      })
    } catch (error) {
      this.logPostHogError('setUserProperties', error)
    }
  }

  /**
   * Flush pending events (useful before shutdown)
   */
  async flush() {
    if (!this.posthog) return

    try {
      await this.posthog.shutdown()
    } catch (error) {
      this.logPostHogError('flush', error)
    }
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy() {
    await this.flush()
  }

  private logPostHogError(method: string, error: unknown) {
    if (error instanceof Error) {
      this.logger.error(`[PostHog:${method}] ${error.message}`)
      if (error.stack) {
        this.logger.error(error.stack)
      }
      return
    }

    this.logger.error(`[PostHog:${method}] ${String(error)}`)
  }
}
