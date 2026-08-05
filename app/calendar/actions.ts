"use server";

import { db } from "@/lib/db";
import { createEntry, updateEntry, deleteEntry } from "@/domain/calendar/queries";
import { revalidatePath } from "next/cache";

export async function addCalendarEntry(formData: FormData) {
  const date = formData.get("date") as string;
  const channel = formData.get("channel") as string;
  const title = formData.get("title") as string;
  const status = (formData.get("status") as string) || "planned";
  const notes = (formData.get("notes") as string) || null;

  if (!date || !channel || !title) {
    return { error: "Date, channel, and title are required" };
  }

  await createEntry(db(), {
    date: new Date(date + "T00:00:00Z"),
    channel,
    title,
    status,
    notes,
  });

  revalidatePath("/calendar");
  return { ok: true };
}

export async function editCalendarEntry(formData: FormData) {
  const id = formData.get("id") as string;
  const date = formData.get("date") as string;
  const channel = formData.get("channel") as string;
  const title = formData.get("title") as string;
  const status = formData.get("status") as string;
  const notes = (formData.get("notes") as string) || null;

  if (!id) return { error: "Missing entry ID" };

  await updateEntry(db(), id, {
    ...(date ? { date: new Date(date + "T00:00:00Z") } : {}),
    ...(channel ? { channel } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    notes,
  });

  revalidatePath("/calendar");
  return { ok: true };
}

export async function removeCalendarEntry(formData: FormData) {
  const id = formData.get("id") as string;
  if (!id) return { error: "Missing entry ID" };

  await deleteEntry(db(), id);
  revalidatePath("/calendar");
  return { ok: true };
}
