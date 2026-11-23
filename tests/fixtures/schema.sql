-- Representative MySQL / MariaDB dump with separate keys and column alterations.
CREATE DATABASE IF NOT EXISTS `atlas_qa`;
USE `atlas_qa`;

CREATE TABLE `parent` (
  `tenant_id` int(11) NOT NULL,
  `id` int(11) NOT NULL,
  `favorite_child` int(11) DEFAULT NULL,
  `label` varchar(120) NOT NULL DEFAULT 'a;b, c'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `child` (
  `id` int(11) NOT NULL,
  `tenant_id` int(11) NOT NULL,
  `parent_id` int(11) NOT NULL,
  `previous_id` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `isolated` (`id` BIGINT PRIMARY KEY);

INSERT INTO `parent` VALUES (1, 1, NULL, 'The words CREATE TABLE; and a,b are data.');

ALTER TABLE `parent` ADD PRIMARY KEY (`tenant_id`, `id`), ADD KEY `idx_label` (`label`(30));
ALTER TABLE `child` ADD PRIMARY KEY (`id`), ADD KEY `idx_parent` (`tenant_id`, `parent_id`);
ALTER TABLE `child` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;
ALTER TABLE `parent` ADD CONSTRAINT `fk_favorite` FOREIGN KEY (`favorite_child`) REFERENCES `child` (`id`) ON DELETE SET NULL;
ALTER TABLE `child`
  ADD CONSTRAINT `fk_parent` FOREIGN KEY (`tenant_id`, `parent_id`) REFERENCES `parent` (`tenant_id`, `id`) ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_previous` FOREIGN KEY (`previous_id`) REFERENCES `child` (`id`);
