import { IsString, IsOptional, IsEmail, MinLength, IsEnum, IsBoolean, IsArray, ArrayMinSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole, PlanType } from '@prisma/client';

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'John Doe' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.jpg' })
  @IsOptional()
  @IsString()
  avatar?: string;
}

export class CreateInternalUserDto {
  @ApiProperty({ example: 'mentor@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'SecurePassword123!' })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'Jane Mentor' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ enum: UserRole, example: UserRole.USER })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

// Admin: Disable/Enable User
export class AdminToggleUserStatusDto {
  @ApiProperty({ example: true, description: 'Whether to disable or enable the user' })
  @IsBoolean()
  isDisabled: boolean;

  @ApiPropertyOptional({ example: 'Violation of terms of service', description: 'Reason for disabling (required when disabling)' })
  @IsOptional()
  @IsString()
  reason?: string;
}

// Admin: Assign Plan to User
export class AdminAssignPlanDto {
  @ApiProperty({ enum: PlanType, example: PlanType.PRO, description: 'The plan to assign to the user' })
  @IsEnum(PlanType)
  plan: PlanType;

  @ApiPropertyOptional({ example: 'Early adopter reward', description: 'Note about why the plan was assigned' })
  @IsOptional()
  @IsString()
  note?: string;
}

// Admin: Bulk Assign Plan to Users
export class AdminBulkAssignPlanDto {
  @ApiProperty({ type: [String], description: 'List of user IDs to update' })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  userIds: string[];

  @ApiProperty({ enum: PlanType, example: PlanType.PRO, description: 'The plan to assign to the users' })
  @IsEnum(PlanType)
  plan: PlanType;

  @ApiPropertyOptional({ example: 'Bulk update', description: 'Note about why the plan was assigned' })
  @IsOptional()
  @IsString()
  note?: string;
}

// Admin: Set Email Verification Status
export class AdminSetEmailVerifiedDto {
  @ApiProperty({ example: true, description: 'Whether the email is verified' })
  @IsBoolean()
  emailVerified: boolean;
}

// Admin: Demote User from Admin
export class AdminDemoteUserDto {
  @ApiProperty({ enum: UserRole, example: UserRole.USER, description: 'The role to demote to (USER only)' })
  @IsEnum(UserRole)
  role: UserRole;
}

// Admin: Get User Details Response
export class AdminUserDetailDto {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role: UserRole;
  userType: string;
  plan: PlanType;
  
  // Account status
  isDisabled: boolean;
  disabledAt?: Date;
  disabledReason?: string;
  emailVerified: boolean;
  emailVerifiedAt?: Date;
  
  // Subscription info
  subscriptionStatus?: string;
  subscriptionEndDate?: Date;
  unlimitedAccess: boolean;
  
  // Admin-assigned plan
  adminAssignedPlan?: PlanType;
  adminAssignedPlanAt?: Date;
  adminAssignedPlanNote?: string;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
