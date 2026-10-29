import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccountActions } from "@/features/auth/hooks/use-account-actions";
import { m } from "@/paraglide/messages";

export function AccountSecurityActions({
  hasPassword,
}: {
  hasPassword: boolean;
}) {
  const [newEmail, setNewEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const {
    changeEmail,
    isChangingEmail,
    deleteAccount,
    isDeletingAccount,
  } = useAccountActions({ hasPassword });

  return (
    <section className="w-full max-w-3xl mx-auto px-6 md:px-0 pb-16 space-y-10">
      <div className="space-y-1">
        <h3 className="text-lg font-serif font-medium text-foreground">
          {m.profile_account_security_title()}
        </h3>
        <p className="text-sm text-muted-foreground">
          {m.profile_account_security_desc()}
        </p>
      </div>

      <div className="space-y-3 border border-border/30 p-5">
        <h4 className="text-sm font-medium">{m.profile_email_change_title()}</h4>
        <p className="text-xs text-muted-foreground">
          {m.profile_email_change_desc()}
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <Input
            type="email"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            placeholder="new@example.com"
            disabled={isChangingEmail}
            className="max-w-sm"
          />
          <Button
            type="button"
            variant="outline"
            disabled={
              isChangingEmail || !newEmail.trim() || !newEmail.includes("@")
            }
            onClick={() => changeEmail(newEmail.trim())}
            className="font-mono text-[10px] uppercase tracking-wider"
          >
            {m.profile_email_change_action()}
          </Button>
        </div>
      </div>

      <div className="space-y-3 border border-destructive/30 p-5">
        <h4 className="text-sm font-medium text-destructive">
          {m.profile_account_delete_title()}
        </h4>
        <p className="text-xs text-muted-foreground">
          {m.profile_account_delete_desc()}
        </p>
        <div className="grid gap-3 sm:max-w-md">
          <Input
            type="email"
            value={confirmEmail}
            onChange={(event) => setConfirmEmail(event.target.value)}
            placeholder={m.profile_account_delete_confirm_placeholder()}
            disabled={isDeletingAccount}
          />
          {hasPassword && (
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={m.profile_current_password()}
              disabled={isDeletingAccount}
            />
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={
            isDeletingAccount ||
            !confirmEmail.trim() ||
            (hasPassword && !password)
          }
          onClick={() => deleteAccount({ password })}
          className="font-mono text-[10px] uppercase tracking-wider border-destructive/40 text-destructive hover:text-destructive"
        >
          {m.profile_account_delete_action()}
        </Button>
      </div>
    </section>
  );
}
