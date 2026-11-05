CREATE TABLE "fulfilment_invoice_files" (
	"drive_file_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"md5" text,
	"modified_time" text NOT NULL,
	"outcome" text NOT NULL,
	"kind" text,
	"invoice_number" text,
	"detail" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
