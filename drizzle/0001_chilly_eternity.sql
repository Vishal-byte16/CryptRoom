CREATE TABLE `room_participants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`roomId` int NOT NULL,
	`participantTokenHash` varchar(64) NOT NULL,
	`isHost` boolean NOT NULL DEFAULT false,
	`connectionState` enum('online','offline') NOT NULL DEFAULT 'offline',
	`joinedAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`leftAt` timestamp,
	CONSTRAINT `room_participants_id` PRIMARY KEY(`id`),
	CONSTRAINT `participants_token_hash_unique` UNIQUE(`participantTokenHash`)
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` int AUTO_INCREMENT NOT NULL,
	`roomId` varchar(6) NOT NULL,
	`activeParticipantCount` int NOT NULL DEFAULT 0,
	`status` enum('active','closed','expired') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastActivity` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`expiresAt` timestamp NOT NULL,
	CONSTRAINT `rooms_id` PRIMARY KEY(`id`),
	CONSTRAINT `rooms_room_id_unique` UNIQUE(`roomId`)
);
--> statement-breakpoint
ALTER TABLE `room_participants` ADD CONSTRAINT `room_participants_roomId_rooms_id_fk` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `participants_room_active_idx` ON `room_participants` (`roomId`,`leftAt`);--> statement-breakpoint
CREATE INDEX `rooms_expires_at_idx` ON `rooms` (`expiresAt`);