import { ForbiddenException } from '@nestjs/common';

export interface CapabilityUser {
  role?: string | null;
}

export function isAdmin(user?: CapabilityUser | null): boolean {
  return user?.role === 'ADMIN';
}

export function assertAdmin(
  user?: CapabilityUser | null,
  message = 'Administrator permissions required',
): void {
  if (!isAdmin(user)) {
    throw new ForbiddenException(message);
  }
}

