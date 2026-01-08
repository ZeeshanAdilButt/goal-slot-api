---
name: OTP Security & Password Change Fix
overview: Add brute force protection to OTP verification and fix the password change flow by implementing OTP-based authentication for password changes.
todos:
  - id: otp-brute-force-constants
    content: Add constants for OTP verification attempt limits and lockout duration
    status: pending
  - id: otp-brute-force-helpers
    content: Create helper methods for tracking verification attempts and lockout status
    status: pending
    dependencies:
      - otp-brute-force-constants
  - id: otp-brute-force-verify
    content: Update verifyOTP() method to check lockout and track failed attempts
    status: pending
    dependencies:
      - otp-brute-force-helpers
  - id: otp-purpose-enum
    content: Add CHANGE_PASSWORD to OTPPurpose enum
    status: pending
  - id: create-dtos
    content: Create SendChangePasswordOTPDto and ChangePasswordDto classes
    status: pending
    dependencies:
      - otp-purpose-enum
  - id: auth-controller-endpoints
    content: Add send-change-password-otp and change-password endpoints to auth controller
    status: pending
    dependencies:
      - create-dtos
  - id: update-auth-service
    content: Update sendChangePasswordOTP and changePassword methods to handle CHANGE_PASSWORD purpose
    status: pending
    dependencies:
      - create-dtos
  - id: frontend-api-client
    content: Add sendChangePasswordOTP and changePassword methods to authApi
    status: pending
  - id: frontend-settings-ui
    content: Update SecuritySettings component to implement two-step OTP flow for password change
    status: pending
    dependencies:
      - frontend-api-client
---

# OTP Security & Password Change Flow Fix

## Phase 1: Add Brute Force Protection to OTP Verification

### 1.1 Add Verification Attempt Tracking Constants

- Add constants in `auth.service.ts`:
- `MAX_OTP_VERIFICATION_ATTEMPTS = 5` (max failed attempts before lockout)
- `OTP_VERIFICATION_LOCKOUT_DURATION = 900000` (15 minutes in milliseconds)

### 1.2 Create Helper Methods for Verification Attempt Tracking

- Add `getVerificationAttemptsKey()` method to generate cache key for tracking attempts
- Add `getVerificationLockoutKey()` method to generate cache key for lockout status
- Add `checkVerificationLockout()` method to check if email/purpose is locked out
- Add `incrementVerificationAttempts()` method to track failed attempts
- Add `resetVerificationAttempts()` method to clear attempts on successful verification

### 1.3 Update `verifyOTP()` Method

- Check for lockout status before processing verification
- If OTP is invalid, increment attempt counter
- If attempts exceed limit, set lockout and throw appropriate error
- If OTP is valid, reset attempt counter and proceed normally
- Apply to all OTP purposes (SIGNUP, FORGOT_PASSWORD, CHANGE_PASSWORD)

## Phase 2: Fix Password Change Flow

### 2.1 Update OTP Purpose Enum

- Add `CHANGE_PASSWORD = 'CHANGE_PASSWORD'` to `OTPPurpose` enum in `auth.dto.ts`

### 2.2 Create Missing DTOs

- Create `SendChangePasswordOTPDto` class with:
- `currentPassword: string` (validated, min length 8)
- Create `ChangePasswordDto` class with:
- `currentPassword: string`
- `otp: string` (6 digits, validated)
- `newPassword: string` (min length 8, validated)

### 2.3 Add Auth Controller Endpoints

- Add `POST /auth/send-change-password-otp` endpoint:
- Protected with `JwtAuthGuard`
- Takes `SendChangePasswordOTPDto` in body
- Calls `authService.sendChangePasswordOTP(userId, currentPassword)`
- Add `POST /auth/change-password` endpoint:
- Protected with `JwtAuthGuard`
- Takes `ChangePasswordDto` in body
- Calls `authService.changePassword(userId, currentPassword, otp, newPassword)`

### 2.4 Update Auth Service Methods

- Update `sendChangePasswordOTP()` to handle `CHANGE_PASSWORD` purpose in email template
- Ensure `changePassword()` properly handles OTP verification with brute force protection
- Both methods should check user exists and validate current password

### 2.5 Update Frontend API Client

- Add `sendChangePasswordOTP` method to `authApi` in `lib/api.ts`
- Add `changePassword` method to `authApi` in `lib/api.ts`

### 2.6 Update Frontend Settings Page

- Modify `SecuritySettings` component in `app/dashboard/settings/page.tsx`:
- Add state for OTP step (request OTP vs verify OTP)
- Add state for OTP input field
- Step 1: User enters current password → calls `sendChangePasswordOTP`
- Step 2: User enters OTP + new password + confirm password → calls `changePassword`
- Show appropriate UI for each step
- Handle loading states and error messages
- Clear form on success

## Implementation Notes

- All brute force protection should use the same cache key pattern as existing rate limiting
- Lockout messages should be user-friendly but not reveal security details
- Frontend should handle expired OTPs gracefully (allow requesting new OTP)
- Ensure SSO users cannot access password change flow (already handled in UI)
- Apply brute force protection consistently across all OTP verification flows