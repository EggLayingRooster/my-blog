import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { useAccountSessions } from "@/features/auth/hooks/use-account-sessions";

export function AccountSessionsSection() {
  const {
    currentToken,
    sessions,
    isLoading,
    revokeSession,
    revokeOtherSessions,
    isRevoking,
  } = useAccountSessions();

  return (
    <section className="w-full max-w-3xl mx-auto px-6 md:px-0 pb-16 space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-lg font-serif font-medium text-foreground">
            {m.profile_sessions_title()}
          </h3>
          <p className="text-sm text-muted-foreground">
            {m.profile_sessions_desc()}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isRevoking || sessions.length <= 1}
          onClick={() => revokeOtherSessions()}
          className="font-mono text-[10px] uppercase tracking-wider"
        >
          {m.profile_sessions_revoke_others()}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">
          {m.profile_sessions_loading()}
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.profile_sessions_empty()}
        </p>
      ) : (
        <div className="divide-y divide-border/30 border border-border/30">
          {sessions.map((session) => {
            const isCurrent = session.token === currentToken;
            return (
              <div
                key={session.id}
                className="flex items-center justify-between gap-4 px-4 py-3 text-xs font-mono"
              >
                <div className="min-w-0 space-y-1">
                  <div className="text-foreground">
                    {session.userAgent || m.profile_sessions_unknown_device()}
                    {isCurrent && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {m.profile_sessions_current()}
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground">
                    {session.ipAddress || "-"} ·{" "}
                    {new Date(session.createdAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isCurrent || isRevoking}
                  onClick={() => revokeSession(session.token)}
                  className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-destructive/80"
                >
                  {m.profile_sessions_revoke()}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
