import { PlanType, UserType } from '@prisma/client'

export const PLAN_LIMITS = {
  FREE: {
    maxGoals: 3,
    maxSchedules: 5,
    maxTasksPerDay: 3,
  },
  BASIC: {
    maxGoals: 10,
    maxSchedules: Infinity,
    maxTasksPerDay: Infinity,
  },
  PRO: {
    maxGoals: Infinity,
    maxSchedules: Infinity,
    maxTasksPerDay: Infinity,
  },
} as const

export type PlanLimits = typeof PLAN_LIMITS[keyof typeof PLAN_LIMITS]

export function resolvePlanLimits(user: {
  userType: UserType
  unlimitedAccess?: boolean | null
  plan: PlanType
  subscriptionStatus?: string | null
  subscriptionEndDate?: Date | string | null
  stripeSubscriptionId?: string | null
  adminAssignedPlan?: PlanType | null
}) {
  if (user.userType === UserType.INTERNAL || user.unlimitedAccess) {
    return PLAN_LIMITS.PRO
  }

  const isStripeActive = !!user.stripeSubscriptionId && user.subscriptionStatus === 'active'
  const isManualActive =
    !user.stripeSubscriptionId &&
    user.subscriptionStatus === 'active' &&
    (!user.subscriptionEndDate || new Date(user.subscriptionEndDate) > new Date())

  const isValidSubscription = isStripeActive || isManualActive || !!user.adminAssignedPlan

  // Be permissive for paid plans: if plan is set and not explicitly canceled in the past, honor it
  const isExplicitlyCanceled = user.subscriptionStatus === 'canceled' &&
    !!user.subscriptionEndDate &&
    new Date(user.subscriptionEndDate) < new Date()

  if (user.plan === PlanType.PRO && (isValidSubscription || !isExplicitlyCanceled)) {
    return PLAN_LIMITS.PRO
  }

  if (user.plan === PlanType.BASIC && (isValidSubscription || !isExplicitlyCanceled)) {
    return PLAN_LIMITS.BASIC
  }

  return PLAN_LIMITS.FREE
}
