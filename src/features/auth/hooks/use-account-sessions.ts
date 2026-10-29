import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "@/lib/auth/auth.client";
import { m } from "@/paraglide/messages";

const SESSIONS_KEY = ["auth", "sessions"] as const;

export function useAccountSessions() {
  const queryClient = useQueryClient();
  const { data: current } = authClient.useSession();
  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: async () => {
      const { data, error } = await authClient.listSessions();
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const revokeSession = useMutation({
    mutationFn: async (token: string) => {
      const { error } = await authClient.revokeSession({ token });
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      toast.success(m.profile_session_revoked());
    },
    onError: (error) => {
      toast.error(m.profile_session_revoke_failed(), {
        description: error.message,
      });
    },
  });

  const revokeOtherSessions = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeOtherSessions();
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      toast.success(m.profile_session_revoked_others());
    },
    onError: (error) => {
      toast.error(m.profile_session_revoke_failed(), {
        description: error.message,
      });
    },
  });

  return {
    currentToken: current?.session?.token,
    sessions: sessions.data ?? [],
    isLoading: sessions.isLoading,
    revokeSession: revokeSession.mutate,
    revokeOtherSessions: revokeOtherSessions.mutate,
    isRevoking: revokeSession.isPending || revokeOtherSessions.isPending,
  };
}
