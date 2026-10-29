import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SystemConfig } from "@/features/config/config.schema";
import { updateSystemConfigFn } from "@/features/config/api/config.api";
import { CONFIG_KEYS, systemConfigQuery } from "@/features/config/queries";

export function useSystemSetting() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    ...systemConfigQuery,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const updatedAt = data?.updatedAt ?? null;
  const version = data?.version ?? 0;

  const saveMutation = useMutation({
    mutationFn: updateSystemConfigFn,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CONFIG_KEYS.system }),
        queryClient.invalidateQueries({ queryKey: CONFIG_KEYS.site }),
      ]);
    },
  });

  return {
    settings: data?.config,
    updatedAt,
    isLoading,
    saveSettings: (config: SystemConfig) =>
      saveMutation.mutateAsync({
        data: {
          config,
          expectedVersion: version,
        },
      }),
  };
}
