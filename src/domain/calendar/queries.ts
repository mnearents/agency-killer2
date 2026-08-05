/**
 * Marketing calendar queries — CRUD for calendar entries.
 */

import { eq, gte, lte, and, asc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { calendarEntries, type CalendarEntry, type NewCalendarEntry } from "@/db/schema";

export async function getEntriesByMonth(
  db: Db,
  year: number,
  month: number // 1-indexed
): Promise<CalendarEntry[]> {
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59));

  return db
    .select()
    .from(calendarEntries)
    .where(and(gte(calendarEntries.date, startDate), lte(calendarEntries.date, endDate)))
    .orderBy(asc(calendarEntries.date));
}

export async function getEntriesByWeek(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<CalendarEntry[]> {
  return db
    .select()
    .from(calendarEntries)
    .where(and(gte(calendarEntries.date, startDate), lte(calendarEntries.date, endDate)))
    .orderBy(asc(calendarEntries.date));
}

export async function getUpcomingEntries(
  db: Db,
  days = 7
): Promise<CalendarEntry[]> {
  const now = new Date();
  const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  return db
    .select()
    .from(calendarEntries)
    .where(and(gte(calendarEntries.date, now), lte(calendarEntries.date, endDate)))
    .orderBy(asc(calendarEntries.date));
}

export async function createEntry(
  db: Db,
  entry: Omit<NewCalendarEntry, "id" | "createdAt" | "updatedAt">
): Promise<CalendarEntry> {
  const [created] = await db
    .insert(calendarEntries)
    .values(entry)
    .returning();
  return created;
}

export async function updateEntry(
  db: Db,
  id: string,
  updates: Partial<Pick<NewCalendarEntry, "date" | "channel" | "title" | "status" | "notes">>
): Promise<CalendarEntry | null> {
  const [updated] = await db
    .update(calendarEntries)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(calendarEntries.id, id))
    .returning();
  return updated ?? null;
}

export async function deleteEntry(db: Db, id: string): Promise<boolean> {
  const result = await db
    .delete(calendarEntries)
    .where(eq(calendarEntries.id, id))
    .returning({ id: calendarEntries.id });
  return result.length > 0;
}
