-- Retire the Copilot Provider: the GitHub Copilot CLI ships no model-listing
-- command, and enumerating models against the bound credentials is now a hard
-- Provider requirement.
--
-- An Agent can reference a Provider through TWO independent paths, and both must
-- be cleaned or the retirement is only half done:
--   1. the legacy `agents.provider_id` column (+ its sibling credential columns), and
--   2. `config.providerChain[*].providerId` — which the dependents API treats as
--      a real dependency (it queries this exact JSON path).
--
-- The hazard in both paths is the same and is NOT a loud failure: a retired
-- binding degrades into the DEFAULT engine rather than into "unbound".
-- `resolveProviderBinding` drops a dangling chain entry silently, and
-- `resolveEngineType` falls back to `cursor` whenever no engine is resolved. So a
-- half-cleaned Agent keeps running — on a different vendor's CLI, and (for the
-- legacy path) with the Copilot GitHub PAT injected as that CLI's API key.
--
-- Clearing the *whole* binding, not just the pointer, is therefore the point:
-- an Agent must come out of this migration genuinely unbound, so it fails at the
-- Provider check where an operator can see why.
--
-- Order matters: every statement identifies the row by `kind`, so the DELETE must
-- come last, while the providers row still exists.

-- 1. Drop copilot entries from every Agent's provider chain, leaving the rest of
--    the chain and the surrounding config untouched.
--
--    The explicit `IS NULL` arm is required, not defensive: a chain entry with
--    `providerId: null` is a legal draft slot (see providerChainItemSchema), and
--    in SQL `NULL NOT IN (...)` evaluates to NULL rather than TRUE — so without
--    it those draft slots would be filtered out alongside the copilot entries,
--    contradicting the "leave the rest of the chain untouched" promise above.
--
--    The `type <> 'object'` / `type = 'object'` guards keep a malformed row from
--    taking down the whole upgrade: `json_extract(value, '$.providerId')` raises
--    "malformed JSON" on a scalar chain entry, which would abort the migration
--    and stop the instance from starting. Such an entry is only reachable via a
--    hand-edited or corrupted row, so it is copied through untouched rather than
--    interpreted. `json(json_quote(value))` re-embeds each surviving entry with
--    its original type instead of double-encoding objects as strings.
UPDATE `agents`
SET `config` = json_set(
      `config`,
      '$.providerChain',
      (
        SELECT COALESCE(json_group_array(json(json_quote(chain_entry.value))), json('[]'))
        FROM json_each(`agents`.`config`, '$.providerChain') AS chain_entry
        WHERE chain_entry.type <> 'object'
           OR json_extract(chain_entry.value, '$.providerId') IS NULL
           OR json_extract(chain_entry.value, '$.providerId') NOT IN (
                SELECT `id` FROM `providers` WHERE `kind` = 'copilot'
              )
      )
    ),
    `updated_at` = (cast(strftime('%s','now') as integer))
WHERE json_valid(`config`)
  AND json_type(`config`, '$.providerChain') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(`agents`.`config`, '$.providerChain') AS chain_entry
    WHERE chain_entry.type = 'object'
      AND json_extract(chain_entry.value, '$.providerId') IN (
        SELECT `id` FROM `providers` WHERE `kind` = 'copilot'
      )
  );
--> statement-breakpoint
-- 2. Stop any Agent left with an empty chain by step 1. An empty chain reads as
--    "no Provider chosen yet" (a repairable draft), which is correct for the
--    editor but wrong for a PUBLISHED Agent: buildAgentConfig does not throw for
--    it, so a live Feishu/gateway/schedule channel would keep invoking and land
--    on the default `cursor` engine with no credentials. Stopping is the honest
--    state — the Agent genuinely has no execution engine any more — and it is
--    reversible from the UI once a new Provider is bound.
--
--    Deliberately this also catches an Agent whose chain was ALREADY empty before
--    this migration, not only one emptied by step 1. Such an Agent is in the same
--    silently-running-on-default-cursor hazard, and leaving it published purely
--    because its emptiness predates the retirement would be arbitrary.
--
--    "Empty" means no ENABLED entry, not zero array length: a chain of only
--    disabled entries resolves to the same unusable state at run time. The count
--    is computed inside a CASE so a non-JSON `config` yields 0 instead of raising
--    "malformed JSON" and aborting the upgrade.
UPDATE `agents`
SET `publish_status` = 'stopped',
    `updated_at` = (cast(strftime('%s','now') as integer))
WHERE `publish_status` = 'published'
  AND (
    CASE
      WHEN json_valid(`config`) AND json_type(`config`, '$.providerChain') = 'array'
      THEN (
        SELECT count(*)
        FROM json_each(`agents`.`config`, '$.providerChain') AS chain_entry
        WHERE chain_entry.type = 'object'
          AND COALESCE(json_extract(chain_entry.value, '$.enabled'), 1) <> 0
      )
      ELSE 0
    END
  ) = 0
  AND json_valid(`config`)
  AND json_type(`config`, '$.providerChain') = 'array';
--> statement-breakpoint
-- 3. Unbind the legacy top-level binding. The credential columns and the stale
--    `config.model` must go with the pointer: with only `provider_id` nulled,
--    buildAgentConfig matches neither the chain branch nor the legacy branch, so
--    nothing clears them — and step 4b still injects `providerApiKey` because the
--    Agent has no providerChain. The run then reaches the default `cursor` engine
--    holding a GitHub PAT.
--
--    Note this row set is WIDER than "legacy Agents": the web client mirrors the
--    primary chain entry into the top-level columns, so a chain-based Agent whose
--    FIRST entry was copilot also matches here. Clearing its credentials is still
--    correct (they are the retired Provider's), but stopping it would not be: its
--    remaining chain entries are exactly the fallback the chain exists to provide.
--    Hence the stop is conditional on nothing usable surviving, while the
--    credential wipe stays unconditional. Without that condition, two Agents that
--    both end up on the same `[claude]` chain would differ in fate purely by which
--    slot copilot happened to occupy.
--
--    The stop condition counts ENABLED entries, not array length: a chain left
--    with only `enabled: false` survivors resolves to an empty enabledChain at
--    run time, so buildAgentConfig does not throw and the Agent lands on the
--    default `cursor` engine — the same silent substitution as an empty chain.
--
--    It is also written as a nested CASE rather than a conjunction of json_*
--    calls. SQLite does NOT short-circuit AND inside a scalar CASE, so a row
--    whose `config` is not valid JSON would raise "malformed JSON" and abort the
--    migration mid-way — leaving 0097 unrecorded and the instance unable to
--    start. Statement 1 guards this same hazard; the guard must not be dropped
--    here just because the expression moved into a CASE.
UPDATE `agents`
SET `provider_id` = NULL,
    `provider_api_key` = NULL,
    `provider_base_url` = NULL,
    `provider_oauth_token` = NULL,
    `auth_mode` = 'apiKey',
    `config` = CASE
      WHEN json_valid(`config`) THEN json_remove(`config`, '$.model')
      ELSE `config`
    END,
    `publish_status` = CASE
      WHEN `publish_status` = 'published'
       AND (
         CASE
           WHEN json_valid(`config`) AND json_type(`config`, '$.providerChain') = 'array'
           THEN (
             SELECT count(*)
             FROM json_each(`agents`.`config`, '$.providerChain') AS chain_entry
             WHERE chain_entry.type = 'object'
               AND COALESCE(json_extract(chain_entry.value, '$.enabled'), 1) <> 0
           )
           ELSE 0
         END
       ) = 0
      THEN 'stopped'
      ELSE `publish_status`
    END,
    `updated_at` = (cast(strftime('%s','now') as integer))
WHERE `provider_id` IN (SELECT `id` FROM `providers` WHERE `kind` = 'copilot');
--> statement-breakpoint
-- 4. Drop the retired Provider row.
DELETE FROM `providers` WHERE `kind` = 'copilot';
--> statement-breakpoint
-- 5. Forget the CLI installation record. The binary itself is no longer
--    reclaimable through the API (the uninstall route resolves the kind from
--    provider-cli-lock.json, which no longer lists copilot), so leaving the row
--    would only assert an install state nothing can act on. Operators reclaim the
--    disk space by removing the directory, or by discarding the CLI volume.
DELETE FROM `cli_installations` WHERE `kind` = 'copilot';
