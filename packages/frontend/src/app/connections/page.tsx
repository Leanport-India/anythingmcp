'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { myConnections } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { StatusPill, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AccessDenied } from '@/components/access-denied';
import { getCapabilities } from '@/lib/capabilities';

type ConnectionStatus = 'PENDING' | 'AUTHORIZED' | 'REVOKED' | 'ERROR';

type AssignedConnection = {
  connectorId: string;
  name: string;
  type: string;
  authMode: 'SHARED' | 'PER_USER';
  instructions: string | null;
  status: ConnectionStatus;
  lastError: string | null;
  authorizedAt: string | null;
};

const STATUS_TONE: Record<ConnectionStatus, Tone> = {
  AUTHORIZED: 'success',
  PENDING: 'neutral',
  ERROR: 'danger',
  REVOKED: 'neutral',
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  AUTHORIZED: 'Connected',
  PENDING: 'Not connected',
  ERROR: 'Connection failed',
  REVOKED: 'Disconnected',
};

export default function MyConnectionsPage() {
  const { token, user, isLoading: authLoading } = useAuth();
  const capabilities = getCapabilities(user);
  const searchParams = useSearchParams();
  const [list, setList] = useState<AssignedConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    if (!token) return;
    myConnections
      .list(token)
      .then(setList)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (!token || !capabilities.canAuthorizeAssignedConnectors) return;
    load();
  }, [token, capabilities.canAuthorizeAssignedConnectors, load]);

  useEffect(() => {
    const oauth = searchParams.get('oauth');
    if (oauth === 'success') setMsg('Connection authorized.');
    if (oauth === 'error') setMsg(`Authorization failed: ${searchParams.get('message') || 'unknown error'}`);
    if (oauth) setTimeout(() => setMsg(''), 5000);
  }, [searchParams]);

  const handleAuthorize = async (connectorId: string) => {
    if (!token) return;
    setBusyId(connectorId);
    try {
      const result = await myConnections.authorize(connectorId, token);
      if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
        return;
      }
      setMsg('Could not start authorization for this connector.');
    } catch (err: any) {
      setMsg(err.message || 'Authorization failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleRevoke = async (connectorId: string) => {
    if (!token) return;
    setBusyId(connectorId);
    try {
      await myConnections.revoke(connectorId, token);
      setMsg('Connection disconnected.');
      load();
    } catch (err: any) {
      setMsg(err.message || 'Failed to disconnect');
    } finally {
      setBusyId(null);
    }
  };

  if (authLoading) return null;
  if (!capabilities.canAuthorizeAssignedConnectors) return <AccessDenied />;

  return (
    <AppShell
      title="My Connections"
      subtitle="Connectors your administrator has made available to you"
    >
      {msg && (
        <div className="mb-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-[13px] text-[var(--text-2)]">
          {msg}
        </div>
      )}

      {loading ? (
        <Card className="p-6 text-sm text-[var(--text-3)]">Loading…</Card>
      ) : list.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm text-[var(--text-2)]">
            No connectors have been assigned to you yet. Ask your administrator to
            assign one from the connector's settings.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {list.map((item) => (
            <Card key={item.connectorId} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="truncate text-[14px] font-semibold text-[var(--text)]">
                    {item.name}
                  </span>
                  <StatusPill tone={STATUS_TONE[item.status]}>
                    {STATUS_LABEL[item.status]}
                  </StatusPill>
                  {item.authMode === 'SHARED' && (
                    <StatusPill tone="info">Shared by admin</StatusPill>
                  )}
                </div>
                {item.instructions && (
                  <p className="mt-1 text-[12.5px] text-[var(--text-3)]">{item.instructions}</p>
                )}
                {item.status === 'ERROR' && item.lastError && (
                  <p className="mt-1 text-[12.5px] text-[var(--danger)]">{item.lastError}</p>
                )}
              </div>

              {item.authMode === 'PER_USER' && (
                <div className="flex flex-shrink-0 gap-2">
                  {item.status === 'AUTHORIZED' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busyId === item.connectorId}
                      onClick={() => handleRevoke(item.connectorId)}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busyId === item.connectorId}
                      onClick={() => handleAuthorize(item.connectorId)}
                    >
                      {item.status === 'ERROR' ? 'Retry' : 'Connect'}
                    </Button>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </AppShell>
  );
}
