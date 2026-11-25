-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ChannelRole" AS ENUM ('OWNER', 'EDITOR', 'APPROVER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PlatformAccountStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "IdeaSelectionMode" AS ENUM ('AUTO_TOP', 'MANUAL');

-- CreateEnum
CREATE TYPE "HookMode" AS ENUM ('REPLACE_NARRATION', 'OVERLAY_ONLY');

-- CreateEnum
CREATE TYPE "WorkflowState" AS ENUM ('IDLE', 'MARKET_RESEARCH', 'TREND_ANALYSIS', 'IDEA_GENERATION', 'WAITING_IDEA_SELECTION', 'SCRIPT_GENERATION', 'VIDEO_GENERATION', 'VOICE_GENERATION', 'VIDEO_EDITING', 'PLATFORM_OPTIMIZATION', 'QUALITY_CHECK', 'WAITING_APPROVAL', 'REVISING', 'READY_FOR_DOWNLOAD', 'PUBLISHING', 'SCHEDULED', 'PERFORMANCE_ANALYSIS', 'LEARNING', 'NEXT_CYCLE', 'PAUSED', 'FAILED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrendType" AS ENUM ('RISING', 'SURGING', 'EVERGREEN', 'SHORT_LIVED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "IdeaStatus" AS ENUM ('PROPOSED', 'SELECTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "VideoFormat" AS ENUM ('SHORTS_9_16', 'LANDSCAPE_16_9');

-- CreateEnum
CREATE TYPE "AuthorType" AS ENUM ('AI', 'USER');

-- CreateEnum
CREATE TYPE "ScenePriority" AS ENUM ('CORE', 'OPTIONAL');

-- CreateEnum
CREATE TYPE "VariantStatus" AS ENUM ('PENDING', 'READY', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT', 'DOWNLOADED', 'SCHEDULED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'REGENERATE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowEntityType" AS ENUM ('RESEARCH_RUN', 'PROJECT');

-- CreateEnum
CREATE TYPE "TransitionTrigger" AS ENUM ('JOB', 'USER', 'AI_DECISION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PricingUnit" AS ENUM ('INPUT_TOKENS_1M', 'OUTPUT_TOKENS_1M', 'CACHE_READ_TOKENS_1M', 'CACHE_WRITE_TOKENS_1M', 'VIDEO_SECOND', 'TTS_CHARS_1M');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "LogCategory" AS ENUM ('AUTH', 'SETTINGS', 'APPROVAL', 'SECRET_ACCESS', 'PROVIDER', 'WORKFLOW', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_members" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "ChannelRole" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "channel_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ChannelStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_settings" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "genre" TEXT,
    "sub_genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "target_audience" TEXT,
    "tone" TEXT,
    "language" TEXT NOT NULL DEFAULT 'ja',
    "region" TEXT NOT NULL DEFAULT 'JP',
    "default_duration_sec" INTEGER NOT NULL DEFAULT 30,
    "ng_words" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "brand_guidelines" TEXT,
    "display_currency" TEXT NOT NULL DEFAULT 'JPY',
    "fx_usd_jpy" DECIMAL(10,4) NOT NULL DEFAULT 150,
    "default_targets" TEXT[] DEFAULT ARRAY['tiktok', 'instagram_reels', 'youtube_shorts']::TEXT[],
    "hook_mode" "HookMode" NOT NULL DEFAULT 'REPLACE_NARRATION',
    "preferred_video_provider" TEXT,
    "preferred_tts_provider" TEXT,
    "voice_id" TEXT,
    "idea_selection_mode" "IdeaSelectionMode" NOT NULL DEFAULT 'AUTO_TOP',
    "auto_publish_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_publish_thresholds" JSONB,
    "daily_budget_usd" DECIMAL(12,2) NOT NULL DEFAULT 30,
    "monthly_budget_usd" DECIMAL(12,2) NOT NULL DEFAULT 600,
    "per_video_budget_usd" DECIMAL(12,2) NOT NULL DEFAULT 10,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "channel_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_credentials" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted_payload" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expires_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_accounts" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "display_name" TEXT,
    "credential_id" UUID,
    "status" "PlatformAccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "platform_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_runs" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "state" "WorkflowState" NOT NULL DEFAULT 'MARKET_RESEARCH',
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "region" TEXT NOT NULL DEFAULT 'JP',
    "params" JSONB,
    "quota_used" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "research_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_videos" (
    "id" UUID NOT NULL,
    "research_run_id" UUID NOT NULL,
    "youtube_video_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description_excerpt" TEXT,
    "channel_youtube_id" TEXT NOT NULL,
    "channel_title" TEXT,
    "channel_subscribers" BIGINT,
    "published_at" TIMESTAMPTZ NOT NULL,
    "duration_sec" INTEGER,
    "is_short_estimated" BOOLEAN NOT NULL DEFAULT false,
    "category_id" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "view_count" BIGINT NOT NULL DEFAULT 0,
    "like_count" BIGINT,
    "comment_count" BIGINT,
    "fetched_at" TIMESTAMPTZ NOT NULL,
    "age_hours" DOUBLE PRECISION NOT NULL,
    "views_per_hour" DOUBLE PRECISION NOT NULL,
    "views_per_subscriber" DOUBLE PRECISION,
    "like_rate" DOUBLE PRECISION,
    "comment_rate" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "competitor_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_trends" (
    "id" UUID NOT NULL,
    "research_run_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "trend_type" "TrendType" NOT NULL,
    "trend_score" DOUBLE PRECISION NOT NULL,
    "score_breakdown" JSONB NOT NULL,
    "competition_level" "RiskLevel",
    "audience_needs" JSONB,
    "title_patterns" JSONB,
    "hook_patterns" JSONB,
    "structure_patterns" JSONB,
    "differentiation" JSONB,
    "uncertainty" TEXT,
    "risks" JSONB,
    "evidence_video_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "market_trends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_ideas" (
    "id" UUID NOT NULL,
    "research_run_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "story" TEXT NOT NULL,
    "duration_sec" INTEGER NOT NULL,
    "scene_count" INTEGER NOT NULL,
    "cta" TEXT NOT NULL,
    "trend_score" DOUBLE PRECISION NOT NULL,
    "originality_score" DOUBLE PRECISION NOT NULL,
    "score_rationale" JSONB,
    "similar_videos" JSONB,
    "copy_risk" "RiskLevel" NOT NULL,
    "policy_risk" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "risks" JSONB,
    "status" "IdeaStatus" NOT NULL DEFAULT 'PROPOSED',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "video_ideas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_projects" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "idea_id" UUID,
    "code" TEXT NOT NULL,
    "format" "VideoFormat" NOT NULL DEFAULT 'SHORTS_9_16',
    "state" "WorkflowState" NOT NULL DEFAULT 'SCRIPT_GENERATION',
    "resume_state" "WorkflowState",
    "current_script_version" INTEGER,
    "current_render_id" UUID,
    "total_cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "paused_reason" TEXT,
    "failed_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "video_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scripts" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "parent_version" INTEGER,
    "content" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" "AuthorType" NOT NULL,
    "revision_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_scenes" (
    "id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "scene_number" INTEGER NOT NULL,
    "priority" "ScenePriority" NOT NULL DEFAULT 'CORE',
    "duration_sec" DOUBLE PRECISION NOT NULL,
    "visual_prompt" TEXT NOT NULL,
    "narration" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL,
    "sound_effect" TEXT NOT NULL DEFAULT '',
    "transition" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_revisions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "from_version" INTEGER NOT NULL,
    "to_version" INTEGER,
    "instruction" TEXT NOT NULL,
    "requested_by" UUID,
    "diff_summary" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_variants" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "target_id" TEXT NOT NULL,
    "script_version" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "metadata_issues" JSONB,
    "render_asset_id" UUID,
    "render_cache_key" TEXT,
    "config_spec_version" TEXT NOT NULL,
    "status" "VariantStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "platform_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publications" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "platform_account_id" UUID,
    "target_id" TEXT NOT NULL,
    "external_post_id" TEXT,
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMPTZ,
    "published_at" TIMESTAMPTZ,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_config_overrides" (
    "id" UUID NOT NULL,
    "target_id" TEXT NOT NULL,
    "patch" JSONB NOT NULL,
    "spec_version" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_config_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_checks" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "script_version" INTEGER NOT NULL,
    "render_id" UUID,
    "total_score" DOUBLE PRECISION NOT NULL,
    "item_scores" JSONB NOT NULL,
    "copyright_risk" "RiskLevel" NOT NULL,
    "policy_risk" "RiskLevel" NOT NULL,
    "ai_content_risk" "RiskLevel" NOT NULL,
    "mass_production_risk" "RiskLevel" NOT NULL,
    "findings" JSONB,
    "measured" JSONB,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "script_version" INTEGER NOT NULL,
    "render_id" UUID,
    "quality_check_id" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "comment" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_jobs" (
    "id" UUID NOT NULL,
    "job_type" TEXT NOT NULL,
    "channel_id" UUID,
    "project_id" UUID,
    "research_run_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "heartbeat_at" TIMESTAMPTZ,
    "next_run_at" TIMESTAMPTZ,
    "error_code" TEXT,
    "error_message" TEXT,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "input" JSONB,
    "output_ref" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workflow_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_transitions" (
    "id" UUID NOT NULL,
    "entity_type" "WorkflowEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "from_state" "WorkflowState",
    "to_state" "WorkflowState" NOT NULL,
    "trigger" "TransitionTrigger" NOT NULL,
    "actor_id" UUID,
    "job_id" UUID,
    "decision_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_decisions" (
    "id" UUID NOT NULL,
    "channel_id" UUID,
    "project_id" UUID,
    "research_run_id" UUID,
    "state" "WorkflowState" NOT NULL,
    "next_action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "parameters" JSONB NOT NULL,
    "data_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accepted" BOOLEAN NOT NULL,
    "rejected_reason" TEXT,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_costs" (
    "id" UUID NOT NULL,
    "job_id" UUID,
    "channel_id" UUID,
    "project_id" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "operation" TEXT NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cache_read_tokens" INTEGER,
    "cache_write_tokens" INTEGER,
    "units" DECIMAL(14,4),
    "unit_type" TEXT,
    "cost_usd" DECIMAL(12,6) NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT true,
    "latency_ms" INTEGER,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_quota_usage" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "quota_bucket" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "units_used" INTEGER NOT NULL DEFAULT 0,
    "units_limit" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "api_quota_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_pricing" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "unit_type" "PricingUnit" NOT NULL,
    "unit_price_usd" DECIMAL(14,6) NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_logs" (
    "id" UUID NOT NULL,
    "level" "LogLevel" NOT NULL,
    "category" "LogCategory" NOT NULL,
    "actor_id" UUID,
    "channel_id" UUID,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "channel_members_user_id_idx" ON "channel_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_members_channel_id_user_id_key" ON "channel_members"("channel_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_settings_channel_id_key" ON "channel_settings"("channel_id");

-- CreateIndex
CREATE INDEX "api_credentials_channel_id_provider_idx" ON "api_credentials"("channel_id", "provider");

-- CreateIndex
CREATE INDEX "platform_accounts_channel_id_idx" ON "platform_accounts"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_accounts_platform_external_account_id_key" ON "platform_accounts"("platform", "external_account_id");

-- CreateIndex
CREATE INDEX "research_runs_channel_id_created_at_idx" ON "research_runs"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "competitor_videos_youtube_video_id_idx" ON "competitor_videos"("youtube_video_id");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_videos_research_run_id_youtube_video_id_key" ON "competitor_videos"("research_run_id", "youtube_video_id");

-- CreateIndex
CREATE INDEX "market_trends_research_run_id_trend_score_idx" ON "market_trends"("research_run_id", "trend_score");

-- CreateIndex
CREATE INDEX "video_ideas_channel_id_status_idx" ON "video_ideas"("channel_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "video_ideas_research_run_id_label_key" ON "video_ideas"("research_run_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "video_projects_idea_id_key" ON "video_projects"("idea_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_projects_code_key" ON "video_projects"("code");

-- CreateIndex
CREATE INDEX "video_projects_channel_id_state_idx" ON "video_projects"("channel_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "scripts_revision_id_key" ON "scripts"("revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "scripts_project_id_version_key" ON "scripts"("project_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "video_scenes_script_id_scene_number_key" ON "video_scenes"("script_id", "scene_number");

-- CreateIndex
CREATE INDEX "project_revisions_project_id_idx" ON "project_revisions"("project_id");

-- CreateIndex
CREATE INDEX "platform_variants_render_cache_key_idx" ON "platform_variants"("render_cache_key");

-- CreateIndex
CREATE UNIQUE INDEX "platform_variants_project_id_target_id_script_version_key" ON "platform_variants"("project_id", "target_id", "script_version");

-- CreateIndex
CREATE INDEX "publications_variant_id_idx" ON "publications"("variant_id");

-- CreateIndex
CREATE INDEX "publications_status_scheduled_at_idx" ON "publications"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "platform_config_overrides_target_id_effective_from_idx" ON "platform_config_overrides"("target_id", "effective_from");

-- CreateIndex
CREATE INDEX "quality_checks_project_id_script_version_idx" ON "quality_checks"("project_id", "script_version");

-- CreateIndex
CREATE INDEX "approval_requests_status_created_at_idx" ON "approval_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_project_id_idx" ON "approval_requests"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_jobs_idempotency_key_key" ON "workflow_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "workflow_jobs_status_next_run_at_idx" ON "workflow_jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "workflow_jobs_status_heartbeat_at_idx" ON "workflow_jobs"("status", "heartbeat_at");

-- CreateIndex
CREATE INDEX "workflow_jobs_project_id_idx" ON "workflow_jobs"("project_id");

-- CreateIndex
CREATE INDEX "workflow_transitions_entity_type_entity_id_created_at_idx" ON "workflow_transitions"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "ai_decisions_project_id_created_at_idx" ON "ai_decisions"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_decisions_channel_id_created_at_idx" ON "ai_decisions"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_costs_created_at_idx" ON "ai_costs"("created_at");

-- CreateIndex
CREATE INDEX "ai_costs_channel_id_created_at_idx" ON "ai_costs"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_costs_provider_created_at_idx" ON "ai_costs"("provider", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_quota_usage_provider_quota_bucket_date_key" ON "api_quota_usage"("provider", "quota_bucket", "date");

-- CreateIndex
CREATE UNIQUE INDEX "provider_pricing_provider_model_unit_type_effective_from_key" ON "provider_pricing"("provider", "model", "unit_type", "effective_from");

-- CreateIndex
CREATE INDEX "system_logs_category_created_at_idx" ON "system_logs"("category", "created_at");

-- CreateIndex
CREATE INDEX "system_logs_channel_id_created_at_idx" ON "system_logs"("channel_id", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "api_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_videos" ADD CONSTRAINT "competitor_videos_research_run_id_fkey" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_trends" ADD CONSTRAINT "market_trends_research_run_id_fkey" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_ideas" ADD CONSTRAINT "video_ideas_research_run_id_fkey" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_ideas" ADD CONSTRAINT "video_ideas_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "video_ideas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "video_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "project_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_scenes" ADD CONSTRAINT "video_scenes_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "video_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_variants" ADD CONSTRAINT "platform_variants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "video_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "platform_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_config_overrides" ADD CONSTRAINT "platform_config_overrides_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "video_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "video_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_quality_check_id_fkey" FOREIGN KEY ("quality_check_id") REFERENCES "quality_checks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_jobs" ADD CONSTRAINT "workflow_jobs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_jobs" ADD CONSTRAINT "workflow_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "video_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_jobs" ADD CONSTRAINT "workflow_jobs_research_run_id_fkey" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workflow_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "ai_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "video_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_research_run_id_fkey" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_costs" ADD CONSTRAINT "ai_costs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workflow_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_costs" ADD CONSTRAINT "ai_costs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_costs" ADD CONSTRAINT "ai_costs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "video_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_logs" ADD CONSTRAINT "system_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_logs" ADD CONSTRAINT "system_logs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
