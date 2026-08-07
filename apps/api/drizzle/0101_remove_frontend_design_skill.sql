-- Remove the retired `frontend-design` built-in Skill.
--
-- It was third-party material bundled into the platform image and seeded as a
-- system-owned, all-users Skill. Deleting the source directory stops the seed
-- from recreating it, but `seedBuiltinSkills()` only inserts and updates — it
-- never deletes — so an already-seeded instance would keep serving an orphaned
-- row whose content no longer tracks any source in this repository.
--
-- Scoped to system-owned rows (`user_id IS NULL`). A user who happened to create
-- their own Skill named `frontend-design` owns a normal private row, and the
-- seeding path deliberately never touched it; neither does this.

-- Unbind first: `agents.skills` is a JSON array of Skill IDs, so the reference
-- has to be removed before the row disappears, or the Agent would keep a
-- dangling ID that resolves to nothing at runtime.
UPDATE `agents`
SET
  `skills` = (
    SELECT json_group_array(value)
    FROM json_each(`agents`.`skills`)
    WHERE value NOT IN (SELECT `id` FROM `skills` WHERE `name` = 'frontend-design' AND `user_id` IS NULL)
  ),
  `updated_at` = (cast(strftime('%s','now') as integer) * 1000)
WHERE
  `skills` IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM json_each(`agents`.`skills`)
    WHERE value IN (SELECT `id` FROM `skills` WHERE `name` = 'frontend-design' AND `user_id` IS NULL)
  );
--> statement-breakpoint
-- Then drop the Skill row itself.
DELETE FROM `skills` WHERE `name` = 'frontend-design' AND `user_id` IS NULL;
