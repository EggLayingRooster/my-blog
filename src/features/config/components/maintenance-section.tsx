import { AdminAuditSection } from "@/features/admin-audit/components/admin-audit-section";
import { CacheMaintenance } from "@/features/cache/components/cache-maintenance";
import { BackupRestoreSection } from "@/features/import-export/components/backup-restore-section";
import { MediaCleanupSection } from "@/features/media/components/media-cleanup-section";
import { NotificationDeliveriesSection } from "@/features/notification/components/notification-deliveries-section";
import { SearchMaintenance } from "@/features/search/components/search-maintenance";
import { VersionMaintenance } from "@/features/version/components/version-maintenance";

export function MaintenanceSection() {
  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-2 duration-700">
      <section className="border border-border/30 bg-background/50 p-8">
        <VersionMaintenance />
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-10">
        <SearchMaintenance />
        <CacheMaintenance />
      </div>

      <NotificationDeliveriesSection />
      <MediaCleanupSection />
      <AdminAuditSection />

      <div className="pt-4 border-t border-border/20">
        <BackupRestoreSection />
      </div>
    </div>
  );
}
