'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { connectors, users, roles } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AppSelect } from '@/components/ui/select';

type Assignment = {
  id: string;
  userId: string | null;
  roleId: string | null;
  enabled: boolean;
  user: { id: string; email: string; name: string | null } | null;
  role: { id: string; name: string } | null;
};

/**
 * Admin panel for controlling which users/roles may see and (for PER_USER
 * connectors) self-authorize a given connector. Lives on the connector
 * detail page — separate from OAuth2 Authorization above it, which sets up
 * the *shared* admin credential.
 */
export function ConnectorAuthorizationAssignments({ connectorId }: { connectorId: string }) {
  const { token } = useAuth();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [userOptions, setUserOptions] = useState<{ value: string; label: string }[]>([]);
  const [roleOptions, setRoleOptions] = useState<{ value: string; label: string }[]>([]);
  const [targetType, setTargetType] = useState<'user' | 'role'>('user');
  const [targetId, setTargetId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    if (!token) return;
    connectors
      .listAuthorizationAssignments(connectorId, token)
      .then(setAssignments)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, connectorId]);

  useEffect(() => {
    if (!token) return;
    load();
    users.list(token).then((list) =>
      setUserOptions(list.map((u: any) => ({ value: u.id, label: u.name ? `${u.name} (${u.email})` : u.email })))
    ).catch(() => {});
    roles.list(token).then((list) =>
      setRoleOptions(list.map((r: any) => ({ value: r.id, label: r.name })))
    ).catch(() => {});
  }, [token, load]);

  const handleAssign = async () => {
    if (!token || !targetId) return;
    setSaving(true);
    try {
      await connectors.createAuthorizationAssignment(
        connectorId,
        targetType === 'user' ? { userId: targetId } : { roleId: targetId },
        token,
      );
      setTargetId('');
      load();
    } catch (err: any) {
      setMsg(err.message || 'Failed to add assignment');
      setTimeout(() => setMsg(''), 4000);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (assignmentId: string) => {
    if (!token) return;
    try {
      await connectors.deleteAuthorizationAssignment(connectorId, assignmentId, token);
      setAssignments((prev) => prev.filter((a) => a.id !== assignmentId));
    } catch (err: any) {
      setMsg(err.message || 'Failed to remove assignment');
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const currentOptions = targetType === 'user' ? userOptions : roleOptions;

  return (
    <Card className="p-[22px]">
      <h3 className="text-sm font-semibold mb-2">Who can authorize this connector</h3>
      <p className="text-sm text-[var(--text-3)] mb-4">
        Only users and roles assigned here will see this connector on their "My
        Connections" page. This is separate from tool-level access control.
      </p>

      {msg && <p className="mb-3 text-[13px] text-[var(--danger)]">{msg}</p>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <AppSelect
          value={targetType}
          onValueChange={(v) => { setTargetType(v as 'user' | 'role'); setTargetId(''); }}
          options={[{ value: 'user', label: 'User' }, { value: 'role', label: 'MCP Role' }]}
          className="h-9 w-[130px] rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px]"
        />
        <AppSelect
          value={targetId}
          onValueChange={setTargetId}
          options={currentOptions}
          className="h-9 min-w-[220px] flex-1 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px]"
        />
        <Button variant="secondary" size="sm" disabled={!targetId || saving} onClick={handleAssign}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--text-3)]">Loading…</p>
      ) : assignments.length === 0 ? (
        <p className="text-sm text-[var(--text-3)]">No one is assigned yet — this connector is invisible to non-admins.</p>
      ) : (
        <div className="grid gap-2">
          {assignments.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between rounded-[9px] border border-[var(--border)] px-3 py-2"
            >
              <span className="text-[13px] text-[var(--text-2)]">
                {a.user ? (a.user.name ? `${a.user.name} (${a.user.email})` : a.user.email) : `Role: ${a.role?.name}`}
              </span>
              <Button variant="ghost" size="sm" onClick={() => handleRemove(a.id)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
