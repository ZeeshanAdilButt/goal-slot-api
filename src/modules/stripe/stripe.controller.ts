import { Controller, Get, Post, Body, UseGuards, Request, Headers, RawBodyRequest, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StripeService } from './stripe.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request as ExpressRequest } from 'express';

@ApiTags('stripe')
@Controller('stripe')
export class StripeController {
  constructor(private stripeService: StripeService) {}

  @Post('create-checkout-session')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a Stripe checkout session for Pro subscription' })
  async createCheckoutSession(@Request() req: any) {
    return this.stripeService.createCheckoutSession(req.user.sub);
  }

  @Post('create-portal-session')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a Stripe customer portal session' })
  async createPortalSession(@Request() req: any) {
    return this.stripeService.createCustomerPortalSession(req.user.sub);
  }

  @Get('subscription-status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current subscription status' })
  async getSubscriptionStatus(@Request() req: any) {
    return this.stripeService.getSubscriptionStatus(req.user.sub);
  }

  @Get('billing-details')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get detailed billing history and invoices' })
  async getBillingDetails(@Request() req: any) {
    return this.stripeService.getBillingDetails(req.user.sub);
  }

  @Post('webhook')
  @ApiOperation({ summary: 'Stripe webhook endpoint' })
  async handleWebhook(
    @Req() req: RawBodyRequest<ExpressRequest>,
    @Headers('stripe-signature') signature: string,
  ) {
    return this.stripeService.handleWebhook(req.rawBody!, signature);
  }

  // Mock endpoints for development
  @Post('mock/activate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mock activate subscription (dev only)' })
  async mockActivate(@Request() req: any) {
    return this.stripeService.mockActivateSubscription(req.user.sub);
  }

  @Post('mock/cancel')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mock cancel subscription (dev only)' })
  async mockCancel(@Request() req: any) {
    return this.stripeService.mockCancelSubscription(req.user.sub);
  }
}
