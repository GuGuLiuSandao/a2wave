CREATE TABLE "a2a_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"data" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_members" (
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_members_agent_id_user_id_pk" PRIMARY KEY("agent_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'cursor' NOT NULL,
	"config" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"icon" text DEFAULT '🤖' NOT NULL,
	"system_prompt" text,
	"skills" jsonb NOT NULL,
	"skill_group_ids" jsonb NOT NULL,
	"mcp_server_ids" jsonb NOT NULL,
	"kb_document_ids" jsonb NOT NULL,
	"publish_status" text DEFAULT 'draft' NOT NULL,
	"provider_api_key" text,
	"provider_base_url" text,
	"provider_oauth_token" text,
	"memory_provider_api_key" text,
	"embedding_api_key" text,
	"auth_mode" text DEFAULT 'apiKey' NOT NULL,
	"endpoint_api_key" text,
	"publish_auth_type" text DEFAULT 'api_key',
	"publish_ip_whitelist" jsonb,
	"publish_description" text,
	"publish_channels" jsonb,
	"oauth_access_mode" text DEFAULT 'feishu_scope' NOT NULL,
	"oauth_allowed_emails" jsonb,
	"a2a_skills" jsonb,
	"a2a_route_targets" jsonb,
	"show_local_child_output" boolean,
	"show_remote_child_output" boolean,
	"feishu_config" jsonb,
	"slack_config" jsonb,
	"discord_config" jsonb,
	"chat_app_config" jsonb,
	"artifact_policy" jsonb,
	"schedule_config" jsonb,
	"published_at" timestamp with time zone,
	"provider_id" text,
	"env" jsonb,
	"workspace_type" text DEFAULT 'temp' NOT NULL,
	"scm_source_id" text,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"a2a_auth_type" text DEFAULT 'api_key' NOT NULL,
	"a2a_endpoint_api_key" text,
	"trust_forwarded_identity" boolean DEFAULT false NOT NULL,
	"schedule_run_as_owner" boolean DEFAULT false NOT NULL,
	"schedule_run_as_user_id" text,
	"user_id" text,
	"pinned_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"created_by" text,
	"access_level" text NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"agent_id" text,
	"user_id" text,
	"filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"kind" text DEFAULT 'file' NOT NULL,
	"mime_type" text,
	"size" bigint,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attachment_refs" (
	"token" text NOT NULL,
	"run_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attachment_refs_token_run_id_pk" PRIMARY KEY("token","run_id")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"resource" text,
	"resource_id" text,
	"details" jsonb,
	"ip_address" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cli_installations" (
	"kind" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"installed_version" text,
	"last_error" text,
	"last_output" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"set_id" text NOT NULL,
	"name" text NOT NULL,
	"turns" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_results" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"case_id" text,
	"case_name" text NOT NULL,
	"turns_snapshot" jsonb NOT NULL,
	"actual_turns" jsonb,
	"review" jsonb,
	"score" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"duration_ms" bigint,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"set_id" text,
	"set_name" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"config_snapshot" jsonb NOT NULL,
	"summary" jsonb,
	"error" text,
	"user_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_card_callbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"trigger_session_id" text NOT NULL,
	"previous_chat_id" text,
	"chat_id" text NOT NULL,
	"trigger_open_id" text,
	"chat_type" text,
	"thread_id" text,
	"original_message_id" text,
	"spec" text NOT NULL,
	"debug_suffix" text,
	"message_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feishu_pending_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text,
	"payload" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_type" text NOT NULL,
	"feishu_doc_token" text,
	"feishu_doc_type" text,
	"feishu_url" text,
	"feishu_app_id" text,
	"feishu_app_secret" text,
	"notion_page_id" text,
	"notion_url" text,
	"notion_token" text,
	"original_filename" text,
	"mime_type" text,
	"storage_path" text,
	"content_hash" text,
	"file_size" bigint,
	"sync_status" text DEFAULT 'idle' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"auto_sync" boolean DEFAULT true NOT NULL,
	"sync_interval_min" integer DEFAULT 60 NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'stdio' NOT NULL,
	"command" text,
	"args" jsonb NOT NULL,
	"cwd" text,
	"url" text,
	"headers" jsonb,
	"env" jsonb,
	"group_config" jsonb,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"usage_scope" text DEFAULT 'private' NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'cursor' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_preset" boolean DEFAULT false NOT NULL,
	"init_script" text,
	"check_script" text,
	"skills_dir" text,
	"mcp_config_path" text,
	"config" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"agent_id" text,
	"order" integer NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" bigint,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"intent" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"execution_metadata" jsonb,
	"trigger_source" text,
	"trigger_session_id" text,
	"trigger_event_id" text,
	"work_dir" text,
	"worktree_config" jsonb,
	"initiator_agent_id" text,
	"user_id" text,
	"trigger_user_name" text,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"reasoning_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_write_tokens" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scm_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"config" jsonb NOT NULL,
	"local_path" text NOT NULL,
	"sync_status" text DEFAULT 'idle' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"initial_sync_completed_at" timestamp with time zone,
	"codegraph_status" text DEFAULT 'idle' NOT NULL,
	"codegraph_last_indexed_at" timestamp with time zone,
	"codegraph_last_error" text,
	"workspaces_path" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scm_sources_local_path_unique" UNIQUE("local_path"),
	CONSTRAINT "scm_sources_workspaces_path_unique" UNIQUE("workspaces_path")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"category" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "settings_category_key_pk" PRIMARY KEY("category","key")
);
--> statement-breakpoint
CREATE TABLE "skill_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text DEFAULT 'package' NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content" text,
	"storage_path" text,
	"group_id" text,
	"user_id" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"remote_source" jsonb,
	"source_dirty" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"role" text DEFAULT 'user' NOT NULL,
	"password_hash" text,
	"email" text,
	"idaas_sub" text,
	"idaas_issuer" text,
	"idaas_protocol" text,
	"locale" text DEFAULT 'zh' NOT NULL,
	"onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "agent_members" ADD CONSTRAINT "agent_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_members" ADD CONSTRAINT "agent_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_members" ADD CONSTRAINT "agent_members_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_scm_source_id_scm_sources_id_fk" FOREIGN KEY ("scm_source_id") REFERENCES "public"."scm_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_schedule_run_as_user_id_users_id_fk" FOREIGN KEY ("schedule_run_as_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_shares" ADD CONSTRAINT "artifact_shares_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_shares" ADD CONSTRAINT "artifact_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_refs" ADD CONSTRAINT "attachment_refs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_set_id_evaluation_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."evaluation_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_task_id_evaluation_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."evaluation_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_case_id_evaluation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."evaluation_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_sets" ADD CONSTRAINT "evaluation_sets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_sets" ADD CONSTRAINT "evaluation_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_tasks" ADD CONSTRAINT "evaluation_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_tasks" ADD CONSTRAINT "evaluation_tasks_set_id_evaluation_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."evaluation_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_tasks" ADD CONSTRAINT "evaluation_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_card_callbacks" ADD CONSTRAINT "feishu_card_callbacks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_pending_messages" ADD CONSTRAINT "feishu_pending_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_initiator_agent_id_agents_id_fk" FOREIGN KEY ("initiator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_sources" ADD CONSTRAINT "scm_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_groups" ADD CONSTRAINT "skill_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_group_id_skill_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."skill_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "a2a_tasks_updated_at_idx" ON "a2a_tasks" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "agent_members_user_id_idx" ON "agent_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agents_user_id_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "artifact_shares_artifact_id_idx" ON "artifact_shares" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_shares_expires_at_idx" ON "artifact_shares" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "artifacts_run_id_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "artifacts_user_id_idx" ON "artifacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "artifacts_expires_at_idx" ON "artifacts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "attachment_refs_token_idx" ON "attachment_refs" USING btree ("token");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_created_at_idx" ON "audit_logs" USING btree ("resource","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_run_id_idx" ON "chat_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evaluation_cases_set_id_idx" ON "evaluation_cases" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "evaluation_cases_set_sort_idx" ON "evaluation_cases" USING btree ("set_id","sort_order");--> statement-breakpoint
CREATE INDEX "evaluation_results_task_id_idx" ON "evaluation_results" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "evaluation_results_task_sort_idx" ON "evaluation_results" USING btree ("task_id","sort_order");--> statement-breakpoint
CREATE INDEX "evaluation_sets_agent_id_idx" ON "evaluation_sets" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "evaluation_tasks_agent_id_created_at_idx" ON "evaluation_tasks" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "evaluation_tasks_status_idx" ON "evaluation_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "feishu_card_callbacks_agent_id_idx" ON "feishu_card_callbacks" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "feishu_card_callbacks_expires_at_idx" ON "feishu_card_callbacks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "feishu_pending_messages_agent_id_idx" ON "feishu_pending_messages" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_kind_unique" ON "providers" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "run_steps_run_id_created_at_idx" ON "run_steps" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "run_steps_created_at_idx" ON "run_steps" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "runs_initiator_agent_id_idx" ON "runs" USING btree ("initiator_agent_id");--> statement-breakpoint
CREATE INDEX "runs_agent_trigger_session_status_created_at_idx" ON "runs" USING btree ("initiator_agent_id","trigger_session_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency_key_unique" ON "runs" USING btree ("initiator_agent_id","trigger_source","trigger_session_id") WHERE trigger_source IN ('api', 'a2a') AND trigger_session_id IS NOT NULL AND status IN ('pending', 'queued', 'running', 'completed');--> statement-breakpoint
CREATE UNIQUE INDEX "runs_oauth_active_session_unique" ON "runs" USING btree ("initiator_agent_id","trigger_source","trigger_session_id") WHERE trigger_source = 'oauth' AND trigger_session_id IS NOT NULL AND status IN ('pending', 'queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "runs_native_chat_event_unique" ON "runs" USING btree ("initiator_agent_id","trigger_source","trigger_event_id") WHERE trigger_source IN ('slack', 'discord') AND trigger_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_user_id_idx" ON "runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "runs_initiator_agent_created_at_idx" ON "runs" USING btree ("initiator_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_created_at_idx" ON "runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "runs_user_id_created_at_idx" ON "runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_updated_at_idx" ON "runs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_idaas_identity_unique" ON "users" USING btree ("idaas_issuer","idaas_sub");