UPDATE `providers`
SET `kind` = CASE `name`
  WHEN 'Cursor CLI' THEN CASE
    WHEN `id` = (SELECT MIN(`candidate`.`id`) FROM `providers` AS `candidate` WHERE `candidate`.`name` = `providers`.`name`) THEN 'cursor'
    ELSE 'legacy:' || `id`
  END
  WHEN 'Claude Code' THEN CASE
    WHEN `id` = (SELECT MIN(`candidate`.`id`) FROM `providers` AS `candidate` WHERE `candidate`.`name` = `providers`.`name`) THEN 'claude-code'
    ELSE 'legacy:' || `id`
  END
  WHEN 'Codex CLI' THEN CASE
    WHEN `id` = (SELECT MIN(`candidate`.`id`) FROM `providers` AS `candidate` WHERE `candidate`.`name` = `providers`.`name`) THEN 'codex'
    ELSE 'legacy:' || `id`
  END
  WHEN 'OpenCode CLI' THEN CASE
    WHEN `id` = (SELECT MIN(`candidate`.`id`) FROM `providers` AS `candidate` WHERE `candidate`.`name` = `providers`.`name`) THEN 'opencode'
    ELSE 'legacy:' || `id`
  END
  WHEN 'Qoder CLI' THEN CASE
    WHEN `id` = (SELECT MIN(`candidate`.`id`) FROM `providers` AS `candidate` WHERE `candidate`.`name` = `providers`.`name`) THEN 'qoder'
    ELSE 'legacy:' || `id`
  END
  WHEN 'Trae CLI' THEN CASE
    WHEN `id` = (SELECT MIN(`candidate`.`id`) FROM `providers` AS `candidate` WHERE `candidate`.`name` = `providers`.`name`) THEN 'trae'
    ELSE 'legacy:' || `id`
  END
  WHEN 'Copilot CLI' THEN CASE
    WHEN `id` = (SELECT MIN(`candidate`.`id`) FROM `providers` AS `candidate` WHERE `candidate`.`name` = `providers`.`name`) THEN 'copilot'
    ELSE 'legacy:' || `id`
  END
  ELSE 'legacy:' || `id`
END;
