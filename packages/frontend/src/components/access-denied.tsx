'use client';

import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function AccessDenied({
  title = 'Access restricted',
  message = 'This area is only available to workspace administrators.',
}: {
  title?: string;
  message?: string;
}) {
  return (
    <AppShell title={title}>
      <Card className="max-w-xl p-6">
        <p className="mb-4 text-sm text-[var(--text-2)]">{message}</p>
        <Link href="/settings">
          <Button variant="secondary">Go to profile</Button>
        </Link>
      </Card>
    </AppShell>
  );
}

