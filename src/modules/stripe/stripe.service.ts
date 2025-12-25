import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanType } from '@prisma/client';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private stripe: Stripe;
  private isMock: boolean;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    this.isMock = !secretKey || secretKey.startsWith('sk_test_mock');

    if (!this.isMock) {
      this.stripe = new Stripe(secretKey!, { apiVersion: '2023-10-16' });
    }
  }

  async createCheckoutSession(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    // Mock mode for development
    if (this.isMock) {
      return this.createMockCheckoutSession(userId, user.email);
    }

    // Real Stripe implementation
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      await this.prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    }

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: this.configService.get<string>('STRIPE_PRICE_ID'),
          quantity: 1,
        },
      ],
      success_url: `${this.configService.get<string>('CORS_ORIGIN')}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.configService.get<string>('CORS_ORIGIN')}/billing/cancel`,
      metadata: { userId: user.id },
    });

    return { url: session.url, sessionId: session.id };
  }

  async createCustomerPortalSession(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.stripeCustomerId) {
      throw new BadRequestException('No subscription found');
    }

    if (this.isMock) {
      return { url: '/billing/mock-portal' };
    }

    const session = await this.stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${this.configService.get<string>('CORS_ORIGIN')}/settings`,
    });

    return { url: session.url };
  }

  async handleWebhook(payload: Buffer, signature: string) {
    if (this.isMock) {
      return { received: true, mock: true };
    }

    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret!);
    } catch (err) {
      throw new BadRequestException(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.handleSubscriptionChange(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.paid':
        await this.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.finalized':
        await this.handleInvoiceFinalized(event.data.object as Stripe.Invoice);
        break;
    }

    return { received: true };
  }

  private async handleCheckoutCompleted(session: Stripe.Checkout.Session) {
    const userId = session.metadata?.userId;
    if (!userId) return;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        stripeSubscriptionId: session.subscription as string,
        subscriptionStatus: 'active',
        plan: PlanType.PRO,
        subscriptionEndDate: null,
      },
    });
  }

  private async handleSubscriptionChange(subscription: Stripe.Subscription) {
    const user = await this.prisma.user.findFirst({
      where: { stripeSubscriptionId: subscription.id },
    });
    if (!user) return;

    const isActive = subscription.status === 'active' || subscription.status === 'trialing';

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: subscription.status,
        plan: isActive ? PlanType.PRO : PlanType.FREE,
        subscriptionEndDate: subscription.cancel_at
          ? new Date(subscription.cancel_at * 1000)
          : null,
      },
    });
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string;
    const user = await this.prisma.user.findFirst({
      where: { stripeCustomerId: customerId },
    });
    if (!user) return;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: 'past_due',
        invoicePending: true,
        lastInvoiceId: invoice.id,
      },
    });
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string;
    const user = await this.prisma.user.findFirst({
      where: { stripeCustomerId: customerId },
    });
    if (!user) return;

    const now = new Date();
    const updateData: any = {
      lastPaymentDate: now,
      invoicePending: false,
      lastInvoiceId: invoice.id,
    };

    // Set first payment date if not already set
    if (!user.firstPaymentDate) {
      updateData.firstPaymentDate = now;
    }

    // Clear past_due status if subscription is now active
    if (user.subscriptionStatus === 'past_due') {
      updateData.subscriptionStatus = 'active';
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });
  }

  private async handleInvoiceFinalized(invoice: Stripe.Invoice) {
    // Invoice finalized means it's been created and is awaiting payment
    const customerId = invoice.customer as string;
    const user = await this.prisma.user.findFirst({
      where: { stripeCustomerId: customerId },
    });
    if (!user) return;

    // Only mark as pending if the invoice is not already paid
    if (invoice.status === 'open') {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          invoicePending: true,
          lastInvoiceId: invoice.id,
        },
      });
    }
  }

  async getSubscriptionStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        plan: true,
        subscriptionStatus: true,
        subscriptionEndDate: true,
        unlimitedAccess: true,
        userType: true,
        firstPaymentDate: true,
        lastPaymentDate: true,
        invoicePending: true,
        lastInvoiceId: true,
      },
    });

    if (!user) throw new BadRequestException('User not found');

    return {
      plan: user.plan,
      status: user.subscriptionStatus,
      endsAt: user.subscriptionEndDate,
      hasUnlimitedAccess: user.unlimitedAccess,
      isInternal: user.userType === 'INTERNAL',
      // Billing tracking
      firstPaymentDate: user.firstPaymentDate,
      lastPaymentDate: user.lastPaymentDate,
      invoicePending: user.invoicePending,
      lastInvoiceId: user.lastInvoiceId,
      // Flags for UI
      requiresPaymentAction: user.invoicePending || user.subscriptionStatus === 'past_due',
      price: '$10/month',
      features: {
        free: ['3 goals', '5 schedules', '3 tasks/day', 'Basic analytics'],
        pro: ['Unlimited goals', 'Unlimited schedules', 'Unlimited tasks', 'Advanced analytics', 'Priority support'],
      },
    };
  }

  /**
   * Get detailed billing history from Stripe
   */
  async getBillingDetails(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        firstPaymentDate: true,
        lastPaymentDate: true,
        invoicePending: true,
        subscriptionStatus: true,
        plan: true,
      },
    });

    if (!user) throw new BadRequestException('User not found');

    // Return basic info if no Stripe customer
    if (!user.stripeCustomerId || this.isMock) {
      return {
        customer: null,
        subscription: null,
        invoices: [],
        paymentMethods: [],
        billingHistory: {
          firstPaymentDate: user.firstPaymentDate,
          lastPaymentDate: user.lastPaymentDate,
          invoicePending: user.invoicePending,
        },
      };
    }

    // Fetch data from Stripe
    const [subscription, invoices, paymentMethods] = await Promise.all([
      user.stripeSubscriptionId
        ? this.stripe.subscriptions.retrieve(user.stripeSubscriptionId)
        : null,
      this.stripe.invoices.list({
        customer: user.stripeCustomerId,
        limit: 12,
      }),
      this.stripe.paymentMethods.list({
        customer: user.stripeCustomerId,
        type: 'card',
      }),
    ]);

    return {
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
      } : null,
      invoices: invoices.data.map(inv => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        amount: inv.amount_due / 100,
        currency: inv.currency,
        created: new Date(inv.created * 1000),
        paidAt: inv.status_transitions.paid_at
          ? new Date(inv.status_transitions.paid_at * 1000)
          : null,
        hostedInvoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
      })),
      paymentMethods: paymentMethods.data.map(pm => ({
        id: pm.id,
        brand: pm.card?.brand,
        last4: pm.card?.last4,
        expMonth: pm.card?.exp_month,
        expYear: pm.card?.exp_year,
      })),
      billingHistory: {
        firstPaymentDate: user.firstPaymentDate,
        lastPaymentDate: user.lastPaymentDate,
        invoicePending: user.invoicePending,
      },
    };
  }

  // Mock implementation for development
  private createMockCheckoutSession(userId: string, email: string) {
    const mockSessionId = `mock_session_${Date.now()}`;
    return {
      url: `/billing/mock-checkout?session=${mockSessionId}&userId=${userId}`,
      sessionId: mockSessionId,
      mock: true,
      message: 'This is a mock checkout. In production, this will redirect to Stripe.',
    };
  }

  async mockActivateSubscription(userId: string) {
    if (!this.isMock) {
      throw new BadRequestException('Mock activation only available in development');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        stripeCustomerId: `mock_cus_${Date.now()}`,
        stripeSubscriptionId: `mock_sub_${Date.now()}`,
        subscriptionStatus: 'active',
        plan: PlanType.PRO,
      },
    });

    return { success: true, message: 'Mock subscription activated' };
  }

  async mockCancelSubscription(userId: string) {
    if (!this.isMock) {
      throw new BadRequestException('Mock cancellation only available in development');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionStatus: 'canceled',
        plan: PlanType.FREE,
        subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      },
    });

    return { success: true, message: 'Mock subscription canceled' };
  }
}
