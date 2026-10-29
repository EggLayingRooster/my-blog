CREATE TABLE `notification_delivery_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`channel` text NOT NULL,
	`target` text DEFAULT 'default' NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_unique_idx` ON `notification_delivery_logs` (`event_id`,`channel`,`target`);--> statement-breakpoint
CREATE INDEX `notification_delivery_created_idx` ON `notification_delivery_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `notification_delivery_status_idx` ON `notification_delivery_logs` (`status`,`created_at`);