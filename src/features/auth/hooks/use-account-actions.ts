import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "@/lib/auth/auth.client";
import { m } from "@/paraglide/messages";

export function useAccountActions(options: { hasPassword: boolean }) {
  const changeEmail = useMutation({
    mutationFn: async (newEmail: string) => {
      const { error } = await authClient.changeEmail({
        newEmail,
        callbackURL: `${window.location.origin}/profile`,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success(m.profile_email_change_sent());
    },
    onError: (error) => {
      toast.error(m.profile_email_change_failed(), {
        description: error.message,
      });
    },
  });

  const deleteAccount = useMutation({
    mutationFn: async (input: { password?: string }) => {
      const { error } = await authClient.deleteUser({
        password: options.hasPassword ? input.password : undefined,
        callbackURL: `${window.location.origin}/`,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await authClient.signOut().catch(() => undefined);
      toast.success(m.profile_account_deleted());
      window.location.assign("/");
    },
    onError: (error) => {
      toast.error(m.profile_account_delete_failed(), {
        description: error.message,
      });
    },
  });

  return {
    changeEmail: changeEmail.mutate,
    isChangingEmail: changeEmail.isPending,
    deleteAccount: deleteAccount.mutate,
    isDeletingAccount: deleteAccount.isPending,
  };
}
