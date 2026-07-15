/**
 * Knowledge base sync orchestrator — coordinates Dropbox file listing,
 * change detection, downloading, and ingestion.
 *
 * Change detection: each file has a Dropbox revision (rev). If the rev
 * matches what we last synced, the file hasn't changed — skip it.
 * The ingestion pipeline then uses content hashing for chunk-level
 * change detection (a file might change but only some chunks differ).
 *
 * Category mapping: Dropbox folder structure maps to KB categories:
 *   /RAD/Agency/00-brand/   → "brand"
 *   /RAD/Agency/01-strategy/ → "strategy"
 *   /RAD/Agency/02-creative/ → "creative"
 *   etc.
 */

import type { DropboxClient, DropboxFileEntry } from "@/integrations/dropbox";
import type { DocumentInput, DocumentCategory } from "./chunking";
import { ingestDocument, type IngestionResult } from "./ingestion";

export interface SyncedFileRecord {
  path: string;
  rev: string;
}

export interface SyncResult {
  totalFiles: number;
  newFiles: number;
  changedFiles: number;
  unchangedFiles: number;
  ingestionResults: IngestionResult[];
}

const FOLDER_TO_CATEGORY: Record<string, DocumentCategory> = {
  "00-brand": "brand",
  "01-strategy": "strategy",
  "02-creative": "creative",
  "03-channels": "email-sms",
  "04-competitive": "strategy",
  "voice": "voice",
};

const TEXT_EXTENSIONS = new Set([".md", ".txt"]);

export function categoryFromPath(path: string): DocumentCategory {
  // Extract the first folder after the root (e.g., "00-brand" from "/RAD/Agency/00-brand/file.md")
  const parts = path.split("/").filter(Boolean);
  for (const part of parts) {
    if (FOLDER_TO_CATEGORY[part]) {
      return FOLDER_TO_CATEGORY[part];
    }
  }
  return "strategy"; // default
}

export function isMarkdownFile(entry: DropboxFileEntry): boolean {
  if (entry.isFolder) return false;
  const ext = entry.name.includes(".")
    ? "." + entry.name.split(".").pop()!.toLowerCase()
    : "";
  return TEXT_EXTENSIONS.has(ext);
}

export function detectChanges(
  files: DropboxFileEntry[],
  lastSynced: Map<string, string>
): { newFiles: DropboxFileEntry[]; changedFiles: DropboxFileEntry[]; unchangedPaths: string[] } {
  const newFiles: DropboxFileEntry[] = [];
  const changedFiles: DropboxFileEntry[] = [];
  const unchangedPaths: string[] = [];

  for (const file of files) {
    const lastRev = lastSynced.get(file.path);
    if (lastRev === undefined) {
      newFiles.push(file);
    } else if (lastRev !== file.rev) {
      changedFiles.push(file);
    } else {
      unchangedPaths.push(file.path);
    }
  }

  return { newFiles, changedFiles, unchangedPaths };
}

export async function syncKnowledgeBase(
  client: DropboxClient,
  rootPath: string,
  lastSynced: Map<string, string>,
  existingHashes: Set<string>
): Promise<SyncResult> {
  // Step 1: List all files
  const allEntries = await client.listFolder(rootPath);

  // Step 2: Filter to markdown/text files only
  const textFiles = allEntries.filter(isMarkdownFile);

  // Step 3: Detect changes
  const { newFiles, changedFiles, unchangedPaths } = detectChanges(textFiles, lastSynced);

  // Step 4: Download and ingest new + changed files
  const filesToProcess = [...newFiles, ...changedFiles];
  const ingestionResults: IngestionResult[] = [];

  for (const file of filesToProcess) {
    const content = await client.downloadText(file.path);
    const title = file.name.replace(/\.(md|txt)$/i, "");
    const category = categoryFromPath(file.path);

    const doc: DocumentInput = {
      title,
      content,
      category,
      sourceFile: file.path,
    };

    const result = ingestDocument(doc, existingHashes);
    ingestionResults.push(result);
  }

  return {
    totalFiles: textFiles.length,
    newFiles: newFiles.length,
    changedFiles: changedFiles.length,
    unchangedFiles: unchangedPaths.length,
    ingestionResults,
  };
}
