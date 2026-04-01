CREATE TABLE IF NOT EXISTS `response_cache` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `cache_key` TEXT NOT NULL, `model` TEXT NOT NULL, `response_body` TEXT NOT NULL, `is_stream` BOOLEAN NOT NULL DEFAULT false, `prompt_tokens` INT DEFAULT 0, `completion_tokens` INT DEFAULT 0, `estimated_cost` DOUBLE DEFAULT 0, `hit_count` INT NOT NULL DEFAULT 0, `created_at` VARCHAR(191) NOT NULL, `expires_at` VARCHAR(191) NOT NULL);
CREATE UNIQUE INDEX `response_cache_key_idx` ON `response_cache` (`cache_key`(191));
CREATE INDEX `response_cache_expires_at_idx` ON `response_cache` (`expires_at`);
CREATE INDEX `response_cache_model_idx` ON `response_cache` (`model`(191));
