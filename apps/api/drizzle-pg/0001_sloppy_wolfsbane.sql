CREATE TABLE "git_trigger_states" (
	"agent_id" text NOT NULL,
	"channel" text NOT NULL,
	"repo_key" text NOT NULL,
	"state" jsonb NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "git_trigger_states_agent_id_channel_repo_key_pk" PRIMARY KEY("agent_id","channel","repo_key")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "glab_config" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "gh_config" jsonb;--> statement-breakpoint
ALTER TABLE "git_trigger_states" ADD CONSTRAINT "git_trigger_states_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;