"use client";

import "./priority.css";

export type TaskPriority = "urgent" | "attention" | "onTrack";

export const priorityOptions: { value: TaskPriority; label: string }[] = [
  { value: "urgent", label: "Urgent" },
  { value: "attention", label: "Attention" },
  { value: "onTrack", label: "On Track" },
];

export function getTaskPriority(value?: string): TaskPriority {
  return value === "urgent" || value === "attention" || value === "onTrack" ? value : "onTrack";
}

export function PriorityControl({ value, onChange, label, className = "" }: {
  value?: string;
  onChange: (priority: TaskPriority) => void;
  label: string;
  className?: string;
}) {
  const priority = getTaskPriority(value);
  const priorityLabel = priorityOptions.find(option => option.value === priority)!.label;
  return <label className={`priority-control priority-${priority} ${className}`}>
    <span className="priority-dot" aria-hidden="true" />
    <span className="priority-visible-label">{priorityLabel}</span>
    <select aria-label={label} value={priority} onChange={event => onChange(getTaskPriority(event.target.value))}>
      {priorityOptions.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

export function PriorityMarker({ value, label }: { value?: string; label: string }) {
  const priority = getTaskPriority(value);
  const priorityLabel = priorityOptions.find(option => option.value === priority)!.label;
  return <span className={`priority-marker priority-${priority}`} aria-label={`${label}: ${priorityLabel}`} title={`${label}: ${priorityLabel}`} />;
}
