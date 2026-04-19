CREATE INDEX IF NOT EXISTS `proxy_logs_channel_id_idx` ON `proxy_logs` (`channel_id`);
CREATE INDEX IF NOT EXISTS `proxy_logs_model_requested_created_at_idx` ON `proxy_logs` (`model_requested`,`created_at`);
