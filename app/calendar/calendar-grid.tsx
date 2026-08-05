"use client";

import { useState } from "react";
import { addCalendarEntry, editCalendarEntry, removeCalendarEntry } from "./actions";

interface CalendarEntry {
  id: string;
  date: Date;
  channel: string;
  title: string;
  status: string;
  notes: string | null;
  aiSuggested: number;
}

interface CalendarGridProps {
  entries: CalendarEntry[];
  initialYear: number;
  initialMonth: number;
}

const CHANNELS = ["Email", "SMS", "Ad", "Reel", "Post", "Story", "Blog"];
const STATUSES = ["idea", "planned", "scheduled", "sent", "posted", "skipped"];

const CHANNEL_COLORS: Record<string, string> = {
  Email: "#0969da",
  SMS: "#e09b13",
  Ad: "#d1242f",
  Reel: "#6f42c1",
  Post: "#1a7f37",
  Story: "#cf222e",
  Blog: "#8250df",
};

const STATUS_OPACITY: Record<string, number> = {
  idea: 0.4,
  planned: 0.7,
  scheduled: 0.9,
  sent: 1,
  posted: 1,
  skipped: 0.3,
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CalendarGrid({ entries, initialYear, initialMonth }: CalendarGridProps) {
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [showForm, setShowForm] = useState<string | null>(null); // date string or null
  const [editingEntry, setEditingEntry] = useState<CalendarEntry | null>(null);

  const prevMonth = () => {
    if (month === 1) { setYear(year - 1); setMonth(12); }
    else setMonth(month - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setYear(year + 1); setMonth(1); }
    else setMonth(month + 1);
  };

  // Build the calendar grid
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0));
  const startDow = firstDay.getUTCDay();
  const daysInMonth = lastDay.getUTCDate();

  const weeks: Array<Array<number | null>> = [];
  let currentWeek: Array<number | null> = new Array(startDow).fill(null);

  for (let d = 1; d <= daysInMonth; d++) {
    currentWeek.push(d);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }

  // Group entries by day
  const entriesByDay = new Map<number, CalendarEntry[]>();
  for (const entry of entries) {
    const entryDate = new Date(entry.date);
    const entryYear = entryDate.getUTCFullYear();
    const entryMonth = entryDate.getUTCMonth() + 1;
    if (entryYear === year && entryMonth === month) {
      const day = entryDate.getUTCDate();
      const existing = entriesByDay.get(day) ?? [];
      existing.push(entry);
      entriesByDay.set(day, existing);
    }
  }

  const today = new Date();
  const isToday = (day: number) =>
    year === today.getFullYear() && month === today.getMonth() + 1 && day === today.getDate();

  return (
    <div>
      {/* Month navigation */}
      <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px" }}>
        <button onClick={prevMonth} style={navBtnStyle}>&larr;</button>
        <h2 style={{ margin: 0, fontSize: "20px", minWidth: "200px", textAlign: "center" }}>
          {MONTHS[month - 1]} {year}
        </h2>
        <button onClick={nextMonth} style={navBtnStyle}>&rarr;</button>
      </div>

      {/* Grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)",
        border: "1px solid #e8e4df",
        borderRadius: "8px",
        overflow: "hidden",
        background: "#fff",
      }}>
        {/* Day headers */}
        {DAYS.map((d) => (
          <div key={d} style={{
            padding: "8px",
            textAlign: "center",
            fontSize: "12px",
            fontWeight: 600,
            color: "#888",
            borderBottom: "1px solid #e8e4df",
            background: "#faf9f7",
          }}>
            {d}
          </div>
        ))}

        {/* Day cells */}
        {weeks.flatMap((week, wi) =>
          week.map((day, di) => (
            <div
              key={`${wi}-${di}`}
              onClick={() => {
                if (day) {
                  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                  setShowForm(dateStr);
                  setEditingEntry(null);
                }
              }}
              style={{
                minHeight: "90px",
                padding: "4px 6px",
                borderRight: di < 6 ? "1px solid #f0ece8" : "none",
                borderBottom: wi < weeks.length - 1 ? "1px solid #f0ece8" : "none",
                cursor: day ? "pointer" : "default",
                background: day && isToday(day) ? "#f0f7ff" : day ? "#fff" : "#faf9f7",
              }}
            >
              {day && (
                <>
                  <div style={{
                    fontSize: "12px",
                    fontWeight: isToday(day) ? 700 : 400,
                    color: isToday(day) ? "#0969da" : "#555",
                    marginBottom: "4px",
                  }}>
                    {day}
                  </div>
                  {(entriesByDay.get(day) ?? []).map((entry) => (
                    <div
                      key={entry.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingEntry(entry);
                        setShowForm(null);
                      }}
                      title={`${entry.title}\n${entry.channel} - ${entry.status}${entry.notes ? "\n" + entry.notes : ""}`}
                      style={{
                        fontSize: "11px",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        marginBottom: "2px",
                        backgroundColor: CHANNEL_COLORS[entry.channel] ?? "#555",
                        color: "#fff",
                        opacity: STATUS_OPACITY[entry.status] ?? 0.7,
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis",
                        cursor: "pointer",
                        border: entry.aiSuggested ? "1px dashed rgba(255,255,255,0.6)" : "none",
                      }}
                    >
                      {entry.title}
                    </div>
                  ))}
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* Channel legend */}
      <div style={{ display: "flex", gap: "12px", marginTop: "12px", flexWrap: "wrap" }}>
        {CHANNELS.map((ch) => (
          <div key={ch} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#666" }}>
            <div style={{ width: "10px", height: "10px", borderRadius: "3px", backgroundColor: CHANNEL_COLORS[ch] }} />
            {ch}
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#666" }}>
          <div style={{ width: "10px", height: "10px", borderRadius: "3px", border: "1px dashed #888", backgroundColor: "#ddd" }} />
          AI suggested
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <EntryForm
          date={showForm}
          onClose={() => setShowForm(null)}
        />
      )}

      {/* Edit form */}
      {editingEntry && (
        <EntryForm
          entry={editingEntry}
          date={new Date(editingEntry.date).toISOString().split("T")[0]}
          onClose={() => setEditingEntry(null)}
        />
      )}
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #e8e4df",
  borderRadius: "6px",
  background: "#fff",
  cursor: "pointer",
  fontSize: "16px",
};

function EntryForm({
  entry,
  date,
  onClose,
}: {
  entry?: CalendarEntry;
  date: string;
  onClose: () => void;
}) {
  const isEdit = !!entry;

  return (
    <div style={{
      position: "fixed",
      top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.3)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 100,
    }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "24px",
          width: "400px",
          maxWidth: "90vw",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0, marginBottom: "16px" }}>
          {isEdit ? "Edit Entry" : `Add Entry — ${date}`}
        </h3>

        <form
          action={async (formData) => {
            if (isEdit) {
              await editCalendarEntry(formData);
            } else {
              await addCalendarEntry(formData);
            }
            onClose();
          }}
        >
          {isEdit && <input type="hidden" name="id" value={entry!.id} />}

          <label style={labelStyle}>Date</label>
          <input
            type="date"
            name="date"
            defaultValue={date}
            style={inputStyle}
          />

          <label style={labelStyle}>Channel</label>
          <select name="channel" defaultValue={entry?.channel ?? "Email"} style={inputStyle}>
            {CHANNELS.map((ch) => (
              <option key={ch} value={ch}>{ch}</option>
            ))}
          </select>

          <label style={labelStyle}>Title</label>
          <input
            type="text"
            name="title"
            defaultValue={entry?.title ?? ""}
            placeholder="Summer planner promo"
            required
            style={inputStyle}
          />

          <label style={labelStyle}>Status</label>
          <select name="status" defaultValue={entry?.status ?? "planned"} style={inputStyle}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <label style={labelStyle}>Notes</label>
          <textarea
            name="notes"
            defaultValue={entry?.notes ?? ""}
            placeholder="Brief, angle, audience..."
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
          />

          <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
            <button type="submit" style={primaryBtnStyle}>
              {isEdit ? "Save" : "Add"}
            </button>
            <button type="button" onClick={onClose} style={secondaryBtnStyle}>
              Cancel
            </button>
            {isEdit && (
              <form
                action={async (fd) => {
                  await removeCalendarEntry(fd);
                  onClose();
                }}
                style={{ marginLeft: "auto" }}
              >
                <input type="hidden" name="id" value={entry!.id} />
                <button type="submit" style={deleteBtnStyle}>
                  Delete
                </button>
              </form>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "13px",
  color: "#666",
  marginBottom: "4px",
  marginTop: "12px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #e8e4df",
  borderRadius: "6px",
  fontSize: "14px",
  boxSizing: "border-box",
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "8px 20px",
  background: "#2c2c2c",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "14px",
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "8px 20px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e8e4df",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "14px",
};

const deleteBtnStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "#fff",
  color: "#d1242f",
  border: "1px solid #d1242f",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "13px",
};
