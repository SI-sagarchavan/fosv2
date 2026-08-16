CREATE TYPE "public"."export_status" AS ENUM('received', 'promoted', 'dismissed');--> statement-breakpoint
CREATE TABLE "figma_export_plates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"export_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"name" text NOT NULL,
	"seq" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "figma_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"file_key" text,
	"file_name" text NOT NULL,
	"page_name" text NOT NULL,
	"root_node_id" text,
	"root_name" text,
	"ir_artifact_id" uuid NOT NULL,
	"node_count" integer NOT NULL,
	"bound_count" integer NOT NULL,
	"loose_count" integer NOT NULL,
	"coverage_percent" real NOT NULL,
	"schema_valid" boolean NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"structural_signature" text,
	"canonical_signature" text,
	"status" "export_status" DEFAULT 'received' NOT NULL,
	"promoted_run_id" uuid,
	"surface_id" uuid,
	"idempotency_key" text NOT NULL,
	"exported_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exported_by" text
);
--> statement-breakpoint
CREATE TABLE "project_figma_files" (
	"project_id" uuid NOT NULL,
	"file_key" text NOT NULL,
	"file_name" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "figma_export_plates" ADD CONSTRAINT "figma_export_plates_export_id_figma_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."figma_exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_export_plates" ADD CONSTRAINT "figma_export_plates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_export_plates" ADD CONSTRAINT "figma_export_plates_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_exports" ADD CONSTRAINT "figma_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_exports" ADD CONSTRAINT "figma_exports_ir_artifact_id_artifacts_id_fk" FOREIGN KEY ("ir_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_exports" ADD CONSTRAINT "figma_exports_surface_id_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."surfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_figma_files" ADD CONSTRAINT "project_figma_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "figma_export_plates_export_node_key" ON "figma_export_plates" USING btree ("export_id","node_id");--> statement-breakpoint
CREATE INDEX "figma_export_plates_node_idx" ON "figma_export_plates" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "figma_export_plates_project_idx" ON "figma_export_plates" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "figma_exports_project_idempotency_key" ON "figma_exports" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "figma_exports_project_received_idx" ON "figma_exports" USING btree ("project_id","received_at");--> statement-breakpoint
CREATE INDEX "figma_exports_frame_idx" ON "figma_exports" USING btree ("project_id","root_node_id","received_at");--> statement-breakpoint
CREATE INDEX "figma_exports_status_idx" ON "figma_exports" USING btree ("project_id","status","received_at");--> statement-breakpoint
CREATE INDEX "figma_exports_ir_idx" ON "figma_exports" USING btree ("ir_artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_figma_files_file_key_key" ON "project_figma_files" USING btree ("file_key");--> statement-breakpoint
CREATE INDEX "project_figma_files_project_idx" ON "project_figma_files" USING btree ("project_id");