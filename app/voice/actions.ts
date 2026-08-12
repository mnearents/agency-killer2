"use server";

import { db } from "@/lib/db";
import { addSample, updateSample, deleteSample, addRule, deleteRule, addBannedWord, deleteBannedWord } from "@/domain/voice/queries";
import { revalidatePath } from "next/cache";

export async function addVoiceSample(formData: FormData): Promise<void> {
  const title = formData.get("title") as string;
  const content = formData.get("content") as string;
  const tagsRaw = formData.get("tags") as string;
  const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];

  if (!title || !content) return;

  await addSample(db(), title, content, tags);
  revalidatePath("/voice");
}

export async function editVoiceSample(formData: FormData): Promise<void> {
  const id = formData.get("id") as string;
  const title = formData.get("title") as string;
  const content = formData.get("content") as string;
  const tagsRaw = formData.get("tags") as string;
  const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];

  if (!id) return;

  await updateSample(db(), id, {
    ...(title ? { title } : {}),
    ...(content ? { content } : {}),
    tags,
  });
  revalidatePath("/voice");
}

export async function removeVoiceSample(formData: FormData): Promise<void> {
  const id = formData.get("id") as string;
  if (!id) return;
  await deleteSample(db(), id);
  revalidatePath("/voice");
}

export async function addVoiceRule(formData: FormData): Promise<void> {
  const rule = formData.get("rule") as string;
  if (!rule) return;
  await addRule(db(), rule);
  revalidatePath("/voice");
}

export async function removeVoiceRule(formData: FormData): Promise<void> {
  const id = formData.get("id") as string;
  if (!id) return;
  await deleteRule(db(), id);
  revalidatePath("/voice");
}

export async function addVoiceBannedWord(formData: FormData): Promise<void> {
  const word = formData.get("word") as string;
  if (!word) return;
  await addBannedWord(db(), word);
  revalidatePath("/voice");
}

export async function removeVoiceBannedWord(formData: FormData): Promise<void> {
  const id = formData.get("id") as string;
  if (!id) return;
  await deleteBannedWord(db(), id);
  revalidatePath("/voice");
}
