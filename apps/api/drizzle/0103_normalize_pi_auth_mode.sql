-- Pi only supported deployment-local login sessions before Agent-scoped proxy
-- credentials were introduced. Historical rows nevertheless contain `apiKey`
-- because that was the generic Agent column/schema default, not because an
-- administrator selected that mode. Reinterpreting those rows as real apiKey
-- bindings would make previously working Agents fail activation (or execution)
-- after the upgrade.
--
-- Normalize both independent Provider reference paths. Credentials and models
-- deliberately remain untouched: localSession ignores them, and preserving the
-- values avoids an unrelated destructive change while restoring the exact
-- pre-feature runtime semantics.

-- 1. Normalize the legacy/top-level Provider binding. The extra mode predicate
-- makes the custom migration idempotent when exercised directly in regression
-- tests or by an operator during recovery.
UPDATE `agents`
SET `auth_mode` = 'localSession',
    `updated_at` = (cast(strftime('%s','now') as integer))
WHERE `provider_id` IN (SELECT `id` FROM `providers` WHERE `kind` = 'pi')
  AND `auth_mode` <> 'localSession';
--> statement-breakpoint
-- 2. Normalize every Pi entry in `config.providerChain`, including disabled
-- fallbacks. A disabled legacy entry can be enabled later, so leaving it on the
-- old generic default merely postpones the same breakage.
--
-- Rebuilding the array through serialized JSON keeps its order and preserves
-- non-object/corrupt draft entries with their original JSON type. Calling
-- `json(...)` at the `json_set` boundary is load-bearing: SQLite otherwise sees
-- the aggregate result as plain text and stores a JSON-encoded string instead of
-- an array.
UPDATE `agents`
SET `config` = json_set(
      `config`,
      '$.providerChain',
      json((
        SELECT '[' || group_concat(serialized.value, ',') || ']'
        FROM (
          SELECT CASE
            WHEN chain_entry.type = 'object'
             AND json_extract(chain_entry.value, '$.providerId') IN (
               SELECT `id` FROM `providers` WHERE `kind` = 'pi'
             )
            THEN json_set(chain_entry.value, '$.authMode', 'localSession')
            WHEN chain_entry.type IN ('object', 'array') THEN chain_entry.value
            WHEN chain_entry.type = 'text' THEN json_quote(chain_entry.value)
            WHEN chain_entry.type = 'true' THEN 'true'
            WHEN chain_entry.type = 'false' THEN 'false'
            WHEN chain_entry.type = 'null' THEN 'null'
            ELSE cast(chain_entry.value AS text)
          END AS value
          FROM json_each(`agents`.`config`, '$.providerChain') AS chain_entry
          ORDER BY cast(chain_entry.key AS integer)
        ) AS serialized
      ))
    ),
    `updated_at` = (cast(strftime('%s','now') as integer))
WHERE json_valid(`config`)
  AND json_type(`config`, '$.providerChain') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(`agents`.`config`, '$.providerChain') AS chain_entry
    WHERE chain_entry.type = 'object'
      AND json_extract(chain_entry.value, '$.providerId') IN (
        SELECT `id` FROM `providers` WHERE `kind` = 'pi'
      )
      AND json_extract(chain_entry.value, '$.authMode') IS NOT 'localSession'
  );
