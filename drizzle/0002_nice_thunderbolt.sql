CREATE TABLE `room_join_challenges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`roomId` int NOT NULL,
	`challengeId` varchar(32) NOT NULL,
	`challenge` varchar(43) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`expiresAt` timestamp NOT NULL,
	CONSTRAINT `room_join_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `join_challenges_id_unique` UNIQUE(`challengeId`)
);
--> statement-breakpoint
ALTER TABLE `rooms` ADD `secretVerifier` varchar(43) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_join_challenges` ADD CONSTRAINT `room_join_challenges_roomId_rooms_id_fk` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `join_challenges_expires_at_idx` ON `room_join_challenges` (`expiresAt`);