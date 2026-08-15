ALTER TABLE "fidelity_reports" DROP CONSTRAINT "fidelity_reports_report_artifact_id_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "run_steps" DROP CONSTRAINT "run_steps_output_artifact_id_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "surface_versions" DROP CONSTRAINT "surface_versions_dsl_artifact_id_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "surface_versions" DROP CONSTRAINT "surface_versions_ir_artifact_id_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "fidelity_reports" ADD CONSTRAINT "fidelity_reports_report_artifact_id_artifacts_id_fk" FOREIGN KEY ("report_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_output_artifact_id_artifacts_id_fk" FOREIGN KEY ("output_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_versions" ADD CONSTRAINT "surface_versions_dsl_artifact_id_artifacts_id_fk" FOREIGN KEY ("dsl_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_versions" ADD CONSTRAINT "surface_versions_ir_artifact_id_artifacts_id_fk" FOREIGN KEY ("ir_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;