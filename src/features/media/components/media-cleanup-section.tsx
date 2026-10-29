import { useMutation, useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import ConfirmationModal from "@/components/ui/confirmation-modal";
import {
  cleanupUnusedMediaFn,
  getTotalMediaSizeFn,
} from "@/features/media/api/media.api";
import { m } from "@/paraglide/messages";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function MediaCleanupSection() {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const totalSize = useQuery({
    queryKey: ["admin", "media-total-size"],
    queryFn: () => getTotalMediaSizeFn(),
  });
  const cleanup = useMutation({
    mutationFn: () => cleanupUnusedMediaFn({ data: { limit: 200 } }),
    onSuccess: (result) => {
      toast.success(m.settings_media_cleanup_success({ count: result.deleted }));
      void totalSize.refetch();
    },
    onError: (error) => {
      toast.error(m.settings_media_cleanup_failed(), {
        description: error.message,
      });
    },
  });

  return (
    <section className="border border-border/30 bg-background/50 p-8">
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <h4 className="text-lg font-serif font-medium tracking-tight">
            {m.settings_media_cleanup_title()}
          </h4>
          <p className="text-sm text-muted-foreground">
            {m.settings_media_cleanup_desc()}
          </p>
          <p className="text-xs font-mono text-muted-foreground/60">
            {m.settings_media_cleanup_total({
              size: formatBytes(totalSize.data ?? 0),
            })}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setIsConfirmOpen(true)}
          disabled={cleanup.isPending}
          className="gap-2 font-mono text-[10px] uppercase tracking-wider border-destructive/30 text-destructive hover:text-destructive"
        >
          <Trash2 size={12} />
          {m.settings_media_cleanup_action()}
        </Button>
      </div>

      <ConfirmationModal
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        onConfirm={() => {
          setIsConfirmOpen(false);
          cleanup.mutate();
        }}
        title={m.settings_media_cleanup_confirm_title()}
        message={m.settings_media_cleanup_confirm_message()}
        confirmLabel={m.settings_media_cleanup_confirm_action()}
      />
    </section>
  );
}
