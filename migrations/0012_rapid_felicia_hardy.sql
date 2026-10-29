CREATE TABLE `admin_audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_audit_created_idx` ON `admin_audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `admin_audit_resource_idx` ON `admin_audit_logs` (`resource_type`,`resource_id`,`created_at`);