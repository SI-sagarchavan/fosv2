CREATE TYPE "public"."artifact_kind" AS ENUM('figma_ir', 'token_set', 'dsl_tree', 'render_png', 'conform_report', 'diff_report', 'screenshot');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('compile', 'conform', 'render', 'diff', 'pipeline');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('draft', 'candidate', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "artifact_kind" NOT NULL,
	"digest" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fidelity_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"surface_version_id" uuid NOT NULL,
	"passed" boolean NOT NULL,
	"score" real NOT NULL,
	"thresholds" jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report_artifact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"theme_uuid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"output_artifact_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"surface_id" uuid,
	"kind" "run_kind" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"idempotency_key" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"error" jsonb,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"requested_by" text
);
--> statement-breakpoint
CREATE TABLE "surface_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"surface_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "version_status" DEFAULT 'draft' NOT NULL,
	"dsl_artifact_id" uuid,
	"ir_artifact_id" uuid,
	"source_run_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "surfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"published_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fidelity_reports" ADD CONSTRAINT "fidelity_reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fidelity_reports" ADD CONSTRAINT "fidelity_reports_surface_version_id_surface_versions_id_fk" FOREIGN KEY ("surface_version_id") REFERENCES "public"."surface_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fidelity_reports" ADD CONSTRAINT "fidelity_reports_report_artifact_id_artifacts_id_fk" FOREIGN KEY ("report_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_output_artifact_id_artifacts_id_fk" FOREIGN KEY ("output_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_surface_id_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."surfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_versions" ADD CONSTRAINT "surface_versions_surface_id_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."surfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_versions" ADD CONSTRAINT "surface_versions_dsl_artifact_id_artifacts_id_fk" FOREIGN KEY ("dsl_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_versions" ADD CONSTRAINT "surface_versions_ir_artifact_id_artifacts_id_fk" FOREIGN KEY ("ir_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surfaces" ADD CONSTRAINT "surfaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_project_digest_key" ON "artifacts" USING btree ("project_id","digest");--> statement-breakpoint
CREATE INDEX "artifacts_project_kind_idx" ON "artifacts" USING btree ("project_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_project_at_idx" ON "audit_log" USING btree ("project_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_type","subject_id","at");--> statement-breakpoint
CREATE INDEX "fidelity_reports_version_idx" ON "fidelity_reports" USING btree ("surface_version_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fidelity_reports_run_version_key" ON "fidelity_reports" USING btree ("run_id","surface_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_key" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_seq_key" ON "run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_project_idempotency_key" ON "runs" USING btree ("project_id","idempotency_key") WHERE "runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "runs_project_status_idx" ON "runs" USING btree ("project_id","status","queued_at");--> statement-breakpoint
CREATE INDEX "runs_surface_idx" ON "runs" USING btree ("surface_id","queued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "surface_versions_surface_version_key" ON "surface_versions" USING btree ("surface_id","version");--> statement-breakpoint
CREATE INDEX "surface_versions_surface_status_idx" ON "surface_versions" USING btree ("surface_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "surfaces_project_key_key" ON "surfaces" USING btree ("project_id","key");