---
name: OTP Email Verification and Forgot Password
overview: Implement OTP-based email verification for signup and forgot password functionality with in-memory caching, rate limiting, and multi-step wizard UI flows.
todos:
  - id: backend-deps
    content: Install cache-manager dependencies in API package.json
    status: pending
  - id: backend-dtos
    content: Add OTP-related DTOs (SendOTPDto, VerifyOTPDto, ForgotPasswordDto, ResetPasswordDto) and update RegisterDto in auth.dto.ts
    status: pending
    dependencies:
      - backend-deps
  - id: backend-cache-module
    content: Configure CacheModule in auth.module.ts with 5min TTL and 1000 max items
    status: pending
    dependencies:
      - backend-deps
  - id: backend-email-service
    content: Add sendOTPEmail method to email.service.ts with brutalist-style template
    status: pending
  - id: backend-auth-service-helpers
    content: Add OTP helper methods (generateOTP, cache key getters, rate limit/cooldown checks) to auth.service.ts
    status: pending
    dependencies:
      - backend-cache-module
  - id: backend-auth-service-otp
    content: Implement sendOTP, verifyOTP, sendForgotPasswordOTP, and resetPassword methods in auth.service.ts
    status: pending
    dependencies:
      - backend-auth-service-helpers
      - backend-email-service
  - id: backend-auth-service-register
    content: Update register method in auth.service.ts to verify OTP, create account, and only delete OTP after successful account creation
    status: pending
    dependencies:
      - backend-auth-service-otp
  - id: backend-auth-check-email
    content: Add checkEmailExists method in auth.service.ts and GET /auth/check-email endpoint in auth.controller.ts
    status: pending
    dependencies:
      - backend-auth-service-otp
  - id: backend-auth-controller
    content: Add send-otp, verify-otp, forgot-password, and reset-password endpoints in auth.controller.ts, update register endpoint
    status: pending
    dependencies:
      - backend-auth-service-register
  - id: frontend-api-client
    content: Add OTP API methods (sendOTP, verifyOTP, forgotPassword, resetPassword) to api.ts and update register method
    status: pending
  - id: frontend-auth-store
    content: Add OTP-related methods to store.ts (sendOTP, verifyOTP, forgotPassword, resetPassword) and update register method
    status: pending
    dependencies:
      - frontend-api-client
  - id: frontend-signup-wizard
    content: "Convert signup page to 2-step wizard: Step 1 (form with email existence check) → Step 2 (OTP verification) with resend functionality"
    status: pending
    dependencies:
      - frontend-auth-store
      - backend-auth-check-email
  - id: frontend-login-link
    content: Add Forgot Password link to login page
    status: pending
  - id: frontend-forgot-password
    content: "Create forgot-password page with 3-step wizard: Step 1 (email) → Step 2 (OTP) → Step 3 (new password)"
    status: pending
    dependencies:
      - frontend-auth-store
---

# OTP Email Verification and Forgot Password Implementation Plan

## Overview

This plan implements OTP-based email verification for user signup and forgot password functionality. The implementation includes backend caching, rate limiting, email templates, and multi-step wizard UI flows.

## Architecture Flow

### Signup Flow

```
User enters email/password/name → Send OTP → User enters OTP → Verify & Create Account → Login
```

### Forgot Password Flow

```
User enters email → Send OTP → User enters OTP → User enters new password → Reset Password → Redirect to Login
```

## Backend Implementation (API)

### 1. Dependencies Installation

**File:** `api/package.json`

- Add `@nestjs/cache-manager` and `cache-manager` to dependencies
- Add `@types/cache-manager` to devDependencies

### 2. DTO Updates

**File:** `api/src/modules/auth/dto/auth.dto.ts`

**New DTOs to add:**

- `OTPPurpose` enum: `SIGNUP | FORGOT_PASSWORD`
- `SendOTPDto`: `{ email: string, purpose: OTPPurpose }`
- `VerifyOTPDto`: `{ email: string, otp: string, purpose: OTPPurpose }`
- `ForgotPasswordDto`: `{ email: string }`
- `ResetPasswordDto`: `{ email: string, otp: string, newPassword: string }`

**Update existing:**

- `RegisterDto`: Add `otp: string` field (6 digits, required)

### 3. Auth Module Configuration

**File:** `api/src/modules/auth/auth.module.ts`

**Changes:**

- Import `CacheModule` from `@nestjs/cache-manager`
- Add `CacheModule.register()` to imports array with:
  - `ttl: 300` (5 minutes)
  - `max: 1000` (max cache items)
  - `isGlobal: false`

### 4. Email Service Enhancement

**File:** `api/src/modules/email/email.service.ts`

**New method to add:**

- `sendOTPEmail(params: { toEmail: string, otp: string, purpose: 'signup' | 'forgot-password' })`
  - Generates HTML/text email template matching existing brutalist style
  - Uses `onboardingEmail` as sender
  - Subject: "Your Goal Slot verification code: {otp}"
  - Includes OTP prominently, expiration notice, security notes

### 5. Auth Service Implementation

**File:** `api/src/modules/auth/auth.service.ts`

**Constants to add:**

- `OTP_EXPIRY = 300` (5 minutes in seconds)
- `OTP_RESEND_COOLDOWN = 60` (60 seconds)
- `MAX_OTP_REQUESTS_PER_HOUR = 5`

**Dependencies to inject:**

- `@Inject(CACHE_MANAGER) private cacheManager: Cache`

**Private helper methods:**

- `generateOTP(): string` - Generates 6-digit numeric OTP
- `getRateLimitKey(email: string, purpose: OTPPurpose): string` - Returns `otp:rate:${email}:${purpose}`
- `getOTPKey(email: string, purpose: OTPPurpose): string` - Returns `otp:${email}:${purpose}`
- `getResendCooldownKey(email: string, purpose: OTPPurpose): string` - Returns `otp:cooldown:${email}:${purpose}`
- `checkRateLimit(email: string, purpose: OTPPurpose): Promise<void>` - Validates max 5 requests/hour
- `checkResendCooldown(email: string, purpose: OTPPurpose): Promise<void>` - Validates 60s cooldown

**Public methods to add/modify:**

- `sendOTP(dto: SendOTPDto)` - Main OTP sending logic
  - Checks rate limit
  - Checks resend cooldown
  - For signup: validates email not exists (backend check as backup)
  - For forgot-password: validates user exists (silent fail for security)
  - Generates OTP
  - Invalidates previous OTP
  - Stores OTP in cache with 5min TTL
  - Sets resend cooldown (60s)
  - Sends email via EmailService
- `verifyOTP(dto: VerifyOTPDto): Promise<boolean>` - Validates OTP
  - Retrieves OTP from cache
  - Compares with provided OTP
  - Throws descriptive errors for expired/invalid OTP
  - Does NOT delete OTP (keeps it in cache for retry if account creation fails)
- `register(dto: RegisterDto)` - Updated registration flow
  - Verifies OTP first (does not delete it yet)
  - Creates user account (in try-catch block)
  - If account creation succeeds: Delete OTP from cache
  - If account creation fails: OTP remains in cache (user can retry)
  - Seeds default categories/labels
  - Sends welcome email
  - Returns tokens
- `checkEmailExists(email: string): Promise<boolean>` - Check if email is already registered
  - Queries database for user with email
  - Returns `true` if exists, `false` otherwise
- `sendForgotPasswordOTP(dto: ForgotPasswordDto)` - Forgot password OTP sender
  - Validates user exists (silent fail)
  - Calls `sendOTP` with `FORGOT_PASSWORD` purpose
- `resetPassword(dto: ResetPasswordDto)` - Password reset logic
  - Verifies user exists
  - Verifies OTP (does not delete it yet)
  - Hashes new password
  - Updates user password in database (in try-catch block)
  - If password update succeeds: Delete OTP from cache
  - If password update fails: OTP remains in cache (user can retry)

**Error handling:**

- `TooManyRequestsException` for rate limit/cooldown violations
- `BadRequestException` for expired OTP
- `UnauthorizedException` for invalid OTP
- `ConflictException` for existing email (signup)

### 6. Auth Controller Updates

**File:** `api/src/modules/auth/auth.controller.ts`

**New endpoints:**

- `GET /auth/check-email?email={email}` - Check if email exists (for frontend validation)
  - Query param: `email: string`
  - Returns: `{ exists: boolean }`
- `POST /auth/send-otp` - Calls `authService.sendOTP()`
  - Body: `SendOTPDto`
  - Returns: `{ success: boolean, message: string }`
- `POST /auth/verify-otp` - Calls `authService.verifyOTP()`
  - Body: `VerifyOTPDto`
  - Returns: `{ success: boolean, message: string }`
- `POST /auth/forgot-password` - Calls `authService.sendForgotPasswordOTP()`
  - Body: `ForgotPasswordDto`
  - Returns: `{ success: boolean, message: string }`
- `POST /auth/reset-password` - Calls `authService.resetPassword()`
  - Body: `ResetPasswordDto`
  - Returns: `{ success: boolean, message: string }`

**Update existing:**

- `POST /auth/register` - Now requires OTP in body
  - Body: `RegisterDto` (includes otp field)
  - Returns: `{ user, accessToken, refreshToken }`

## Frontend Implementation (Web)

### 1. API Client Updates

**File:** `web/src/lib/api.ts`

**New methods in `authApi` object:**

- `checkEmailExists(email: string)` - Check if email is already registered (for signup validation)
  - Can use existing endpoint or create new one: `GET /auth/check-email?email=${email}`
  - Returns: `{ exists: boolean }`
- `sendOTP(data: { email: string, purpose: 'signup' | 'forgot-password' })` - POST to `/auth/send-otp`
- `verifyOTP(data: { email: string, otp: string, purpose: 'signup' | 'forgot-password' })` - POST to `/auth/verify-otp`
- `forgotPassword(data: { email: string })` - POST to `/auth/forgot-password`
- `resetPassword(data: { email: string, otp: string, newPassword: string })` - POST to `/auth/reset-password`

**Update existing:**

- `register(data)` - Now includes `otp` field in request body

### 2. Auth Store Updates

**File:** `web/src/lib/store.ts`

**New state properties (optional):**

- `otpEmail: string | null` - Stores email during OTP flow
- `otpPurpose: 'signup' | 'forgot-password' | null` - Tracks OTP purpose

**New methods:**

- `checkEmailExists(email: string)` - Calls `authApi.checkEmailExists()` to check if email is registered
- `sendOTP(email: string, purpose: 'signup' | 'forgot-password')` - Calls `authApi.sendOTP()`
- `verifyOTP(email: string, otp: string, purpose: 'signup' | 'forgot-password')` - Calls `authApi.verifyOTP()`
- `forgotPassword(email: string)` - Calls `authApi.forgotPassword()`
- `resetPassword(email: string, otp: string, newPassword: string)` - Calls `authApi.resetPassword()`

**Update existing:**

- `register(email, password, name, otp)` - Now accepts otp parameter

### 3. Signup Page - Multi-Step Wizard

**File:** `web/src/app/signup/page.tsx`

**State management:**

- `step: 1 | 2` - Current wizard step
- `formData: { email, password, name }` - Stores form data between steps
- `otp: string` - OTP input value
- `isSendingOTP: boolean` - Loading state for OTP send
- `isVerifying: boolean` - Loading state for OTP verification
- `resendCooldown: number` - Countdown timer (60s)
- `error: string | null` - Error message

**Step 1 - Registration Form:**

- Email, Password, Name inputs
- "Send Verification Code" button
- On submit: 

  1. Validate form fields
  2. Check if email exists: Call `checkEmailExists(email)` 
  3. If email exists: Show error "Email already registered" and stop
  4. If email doesn't exist: Call `sendOTP(email, 'signup')` 
  5. On success: Move to step 2

- Show error messages clearly

**Step 2 - OTP Verification:**

- Display email (read-only)
- Use `InputOTP` component with 6 slots
- Auto-advance on complete (optional)
- "Verify & Create Account" button
- "Resend Code" button (disabled during cooldown, shows countdown)
- On submit: Call `register(email, password, name, otp)` 
  - If account creation fails: OTP remains valid in cache (user can retry with same OTP)
  - On success: Redirect to dashboard
- Show error messages (expired, invalid, account creation errors, etc.)

**UI Components:**

- Use existing brutalist styling
- Loading states with `Loading` component
- Error messages in red/bold
- Success toast notifications

### 4. Forgot Password Page

**File:** `web/src/app/forgot-password/page.tsx` (NEW FILE)

**State management:**

- `step: 1 | 2 | 3` - Current wizard step
- `email: string` - User email
- `otp: string` - OTP input value
- `newPassword: string` - New password
- `confirmPassword: string` - Password confirmation
- `isSendingOTP: boolean` - Loading state
- `isVerifying: boolean` - Loading state
- `isResetting: boolean` - Loading state
- `resendCooldown: number` - Countdown timer
- `error: string | null` - Error message

**Step 1 - Email Input:**

- Email input field
- "Send Verification Code" button
- On submit: Call `forgotPassword(email)` → On success: Move to step 2
- Show error messages

**Step 2 - OTP Verification:**

- Display email (read-only)
- Use `InputOTP` component with 6 slots
- "Verify Code" button
- "Resend Code" button (with cooldown)
- On submit: Call `verifyOTP(email, otp, 'forgot-password')` → On success: Move to step 3
- Show error messages

**Step 3 - New Password:**

- New password input (with show/hide toggle)
- Confirm password input
- "Reset Password" button
- Password validation (min 8 chars, match confirmation)
- On submit: Call `resetPassword(email, otp, newPassword)`
  - If password reset fails: OTP remains valid in cache (user can retry with same OTP)
  - On success: Show success message → Redirect to `/login` after 2s
- Show error messages

**UI Components:**

- Match existing brutalist styling
- Loading states
- Error messages
- Success toast

### 5. Login Page Updates

**File:** `web/src/app/login/page.tsx`

**Changes:**

- Add "Forgot Password?" link below password field
- Link to `/forgot-password`
- Style: `font-bold text-accent-blue hover:underline`

## Implementation Details

### Cache Key Strategy

- OTP storage: `otp:${email}:${purpose}` - TTL: 5 minutes
- Rate limiting: `otp:rate:${email}:${purpose}` - TTL: 1 hour, value: count
- Resend cooldown: `otp:cooldown:${email}:${purpose}` - TTL: 60 seconds

### Error Messages (Backend)

- Rate limit: "Too many OTP requests. Please wait before requesting another code."
- Cooldown: "Please wait 60 seconds before requesting a new code."
- Expired OTP: "OTP not found or expired. Please request a new code."
- Invalid OTP: "Invalid OTP code. Please try again."
- Email exists (signup): "Email already registered"
- User not found (reset): "User not found"

### Security Considerations

- Silent fail for non-existent emails in forgot password (prevents enumeration)
- Frontend checks email existence before sending OTP for signup (prevents unnecessary OTP sends)
- OTP deleted only after successful account creation/password reset (allows retry on failure)
- OTP remains in cache with existing TTL (5 minutes) - user can retry as long as OTP is valid
- Previous OTP invalidated on resend
- Rate limiting prevents abuse
- Cooldown prevents spam

### Testing Checklist

- Signup flow: Email validation, OTP send, OTP verify, account creation
- Forgot password: Email validation, OTP send, OTP verify, password reset
- Rate limiting: Max 5 requests/hour
- Resend cooldown: 60 second wait
- Error handling: All error scenarios
- UI/UX: Loading states, error messages, success flows

## File Summary

### Backend Files to Modify

1. `api/package.json` - Add cache dependencies
2. `api/src/modules/auth/dto/auth.dto.ts` - Add new DTOs, update RegisterDto
3. `api/src/modules/auth/auth.module.ts` - Add CacheModule
4. `api/src/modules/email/email.service.ts` - Add sendOTPEmail method
5. `api/src/modules/auth/auth.service.ts` - Add OTP methods, update register
6. `api/src/modules/auth/auth.controller.ts` - Add new endpoints, update register

### Frontend Files to Modify

1. `web/src/lib/api.ts` - Add OTP API methods
2. `web/src/lib/store.ts` - Add OTP store methods
3. `web/src/app/signup/page.tsx` - Convert to multi-step wizard
4. `web/src/app/login/page.tsx` - Add forgot password link
5. `web/src/app/forgot-password/page.tsx` - Create new file (3-step wizard)

### New Files

- `web/src/app/forgot-password/page.tsx` - Forgot password wizard page