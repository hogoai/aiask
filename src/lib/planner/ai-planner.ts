import type { AIASKContext, PlannerChange } from "../ai/contracts";

export type PlannerIdea = { id: string; text: string };
export type PlannerEventRecord = {
  id: string;
  todoId: string | null;
  ideaId: string | null;
  title: string;
  scheduledDate: string;
  scheduledTime: string | null;
  priority?: "urgent" | "attention" | "onTrack";
  origin?: "calendar" | "task-deadline";
  description: string;
  createdAt: string;
  ownerId?: string;
};
export type PlannerTodoRecord = {
  id: string;
  eventId: string | null;
  ideaId: string | null;
  title: string;
  dueDate: string;
  status: "Open" | "Done";
  priority?: "urgent" | "attention" | "onTrack";
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  remindAt?: string;
  remindedAt?: string;
  reminderPending?: boolean;
  originConversationId?: string;
  ownerId?: string;
};
export type PlannerRecords = { events: PlannerEventRecord[]; todos: PlannerTodoRecord[] };

function ideaContext(ideas: PlannerIdea[], ids: Set<string>) {
  return ideas.filter(idea => ids.has(idea.id)).slice(0, 100).map(idea => JSON.stringify({
    id: idea.id,
    text: idea.text.slice(0, 1400),
  }));
}

export function buildCalendarPlannerContext(
  selectedDate: string,
  events: PlannerEventRecord[],
  todos: PlannerTodoRecord[],
  ideas: PlannerIdea[],
): AIASKContext {
  const dayEvents = events.filter(event => event.scheduledDate === selectedDate);
  const linkedTodoIds = new Set(dayEvents.map(event => event.todoId).filter((id): id is string => Boolean(id)));
  const dayTodos = todos.filter(todo => linkedTodoIds.has(todo.id) || todo.dueDate === selectedDate);
  const ideaIds = new Set([
    ...dayEvents.map(event => event.ideaId),
    ...dayTodos.map(todo => todo.ideaId),
  ].filter((id): id is string => Boolean(id)));

  return {
    goal: `Calendar planning for selected date ${selectedDate}. Use only these current records.`,
    relevantCalendarItems: dayEvents.slice(0, 100).map(event => JSON.stringify({
      id: event.id, title: event.title.slice(0, 300), date: event.scheduledDate,
      time: event.scheduledTime, priority: event.priority ?? null, origin: event.origin ?? "calendar",
      description: event.description === event.title ? null : event.description.slice(0, 500),
      linkedTaskId: event.todoId,
    })),
    relevantTasks: dayTodos.slice(0, 100).map(todo => JSON.stringify({
      id: todo.id, title: todo.title.slice(0, 300), dueDate: todo.dueDate || null,
      status: todo.status, priority: todo.priority ?? null, ideaId: todo.ideaId,
    })),
    relevantNotes: ideaContext(ideas, ideaIds),
  };
}

export function buildTodoPlannerContext(
  todos: PlannerTodoRecord[],
  events: PlannerEventRecord[],
  ideas: PlannerIdea[],
): AIASKContext {
  const orderedTodos = [...todos].sort((a, b) => {
    if (a.status !== b.status) return a.status === "Open" ? -1 : 1;
    return (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31");
  }).slice(0, 100);
  const taskIds = new Set(orderedTodos.map(todo => todo.id));
  const linkedEvents = events.filter(event => event.todoId && taskIds.has(event.todoId)).slice(0, 100);
  const ideaIds = new Set(orderedTodos.map(todo => todo.ideaId).filter((id): id is string => Boolean(id)));

  return {
    goal: `To-do planning. Use the supplied task status, due dates, priorities, and linked ideas as current browser records. ${todos.length > orderedTodos.length ? `Showing ${orderedTodos.length} tasks, with open and nearer-due tasks first.` : ""}`,
    relevantTasks: orderedTodos.map(todo => JSON.stringify({
      id: todo.id, title: todo.title.slice(0, 300), dueDate: todo.dueDate || null,
      status: todo.status, priority: todo.priority ?? null, ideaId: todo.ideaId,
      calendarLinked: Boolean(todo.eventId),
    })),
    relevantCalendarItems: linkedEvents.map(event => JSON.stringify({
      id: event.id, title: event.title.slice(0, 300), date: event.scheduledDate,
      time: event.scheduledTime, linkedTaskId: event.todoId,
    })),
    relevantNotes: ideaContext(ideas, ideaIds),
  };
}

export type AppliedPlannerChange = {
  ok: true;
  changed: boolean;
  planner: PlannerRecords;
  createdTodo?: PlannerTodoRecord;
  selectedDate?: string;
} | {
  ok: false;
  error: string;
};

function sameTitle(left: string, right: string) {
  return left.trim().replace(/\s+/g, " ").toLocaleLowerCase() === right.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function applyPlannerChange(
  planner: PlannerRecords,
  change: PlannerChange,
  options: { now: string; ownerId?: string; conversationId: string; createId: () => string },
): AppliedPlannerChange {
  if (change.action === "none") return { ok: true, changed: false, planner };
  const { now, ownerId, conversationId, createId } = options;
  const priority = change.priority ?? "onTrack";

  if (change.action === "create_task") {
    const title = change.title!.trim();
    const dueDate = change.dueDate ?? "";
    if (planner.todos.some(todo => todo.status === "Open" && sameTitle(todo.title, title) && todo.dueDate === dueDate)) {
      return { ok: false, error: "A matching open task already exists. Review it before creating another." };
    }
    const id = createId();
    const eventId = dueDate ? createId() : null;
    const todo: PlannerTodoRecord = {
      ownerId, originConversationId: conversationId, id, eventId, ideaId: change.ideaId,
      title, dueDate, status: "Open", priority, createdAt: now, updatedAt: now,
    };
    const event: PlannerEventRecord | null = eventId ? {
      ownerId, id: eventId, todoId: id, ideaId: change.ideaId, title, scheduledDate: dueDate,
      scheduledTime: null, description: title, priority, createdAt: now, origin: "task-deadline",
    } : null;
    return {
      ok: true, changed: true, planner: {
        todos: [todo, ...planner.todos],
        events: event ? [...planner.events, event] : planner.events,
      }, createdTodo: todo, selectedDate: dueDate || undefined,
    };
  }

  if (change.action === "create_calendar_event") {
    const title = change.title!.trim();
    const scheduledDate = change.scheduledDate!;
    const scheduledTime = change.scheduledTime;
    if (planner.events.some(event => sameTitle(event.title, title) && event.scheduledDate === scheduledDate && event.scheduledTime === scheduledTime)) {
      return { ok: false, error: "A matching calendar event already exists at that date and time." };
    }
    const eventId = createId();
    const todoId = createId();
    const event: PlannerEventRecord = {
      ownerId, id: eventId, todoId, ideaId: change.ideaId, title, scheduledDate, scheduledTime,
      description: title, priority, createdAt: now, origin: "calendar",
    };
    const todo: PlannerTodoRecord = {
      ownerId, id: todoId, eventId, ideaId: change.ideaId, title, dueDate: scheduledDate,
      status: "Open", priority, createdAt: now, updatedAt: now,
    };
    return {
      ok: true, changed: true,
      planner: { events: [...planner.events, event], todos: [todo, ...planner.todos] },
      createdTodo: todo, selectedDate: scheduledDate,
    };
  }

  if (change.action === "delete_task") {
    const todo = planner.todos.find(item => item.id === change.targetId);
    if (!todo) return { ok: false, error: "That task no longer exists. Refresh the planner context and try again." };
    return {
      ok: true, changed: true,
      planner: {
        todos: planner.todos.filter(item => item.id !== todo.id),
        events: planner.events.filter(event => event.id !== todo.eventId && event.todoId !== todo.id),
      },
    };
  }

  if (change.action === "delete_calendar_event") {
    const event = planner.events.find(item => item.id === change.targetId);
    if (!event) return { ok: false, error: "That calendar event no longer exists. Refresh the planner context and try again." };
    return {
      ok: true, changed: true,
      planner: {
        events: planner.events.filter(item => item.id !== event.id),
        todos: planner.todos.filter(todo => todo.id !== event.todoId && todo.eventId !== event.id),
      },
    };
  }

  if (change.action === "update_task") {
    const current = planner.todos.find(item => item.id === change.targetId);
    if (!current) return { ok: false, error: "That task no longer exists. Refresh the planner context and try again." };
    const nextTodo: PlannerTodoRecord = {
      ...current,
      ...(change.fields.includes("title") ? { title: change.title!.trim() } : {}),
      ...(change.fields.includes("dueDate") ? { dueDate: change.dueDate ?? "", updatedAt: now } : {}),
      ...(change.fields.includes("status") ? {
        status: change.status!,
        completedAt: change.status === "Done" ? now : undefined,
        updatedAt: now,
      } : {}),
      ...(change.fields.includes("priority") ? { priority: change.priority! } : {}),
      ...(change.fields.includes("ideaId") ? { ideaId: change.ideaId } : {}),
    };
    let events = planner.events;
    const linkedEvent = planner.events.find(event => event.id === current.eventId || event.todoId === current.id);
    if (linkedEvent) {
      const newDueDate = change.fields.includes("dueDate") ? change.dueDate ?? "" : nextTodo.dueDate;
      if (!newDueDate && linkedEvent.origin === "task-deadline") {
        events = planner.events.filter(event => event.id !== linkedEvent.id);
        nextTodo.eventId = null;
      } else if (!newDueDate) {
        events = planner.events.map(event => event.id === linkedEvent.id ? { ...event, todoId: null } : event);
        nextTodo.eventId = null;
      } else {
        events = planner.events.map(event => event.id === linkedEvent.id ? {
          ...event,
          ...(change.fields.includes("title") ? { title: nextTodo.title, description: nextTodo.title } : {}),
          ...(change.fields.includes("dueDate") && newDueDate ? { scheduledDate: newDueDate } : {}),
          ...(change.fields.includes("priority") ? { priority: nextTodo.priority } : {}),
          ...(change.fields.includes("ideaId") ? { ideaId: nextTodo.ideaId } : {}),
        } : event);
      }
    } else if (change.fields.includes("dueDate") && nextTodo.dueDate) {
      const eventId = createId();
      nextTodo.eventId = eventId;
      events = [...planner.events, {
        ownerId: current.ownerId, id: eventId, todoId: current.id, ideaId: nextTodo.ideaId,
        title: nextTodo.title, scheduledDate: nextTodo.dueDate, scheduledTime: null,
        description: nextTodo.title, priority: nextTodo.priority ?? "onTrack",
        createdAt: now, origin: "task-deadline",
      }];
    }
    return {
      ok: true, changed: true,
      planner: {
        todos: planner.todos.map(todo => todo.id === current.id ? nextTodo : todo),
        events,
      },
      selectedDate: change.fields.includes("dueDate") ? nextTodo.dueDate || undefined : undefined,
    };
  }

  const current = planner.events.find(item => item.id === change.targetId);
  if (!current) return { ok: false, error: "That calendar event no longer exists. Refresh the planner context and try again." };
  const nextEvent: PlannerEventRecord = {
    ...current,
    ...(change.fields.includes("title") ? { title: change.title!.trim(), description: change.title!.trim() } : {}),
    ...(change.fields.includes("scheduledDate") ? { scheduledDate: change.scheduledDate! } : {}),
    ...(change.fields.includes("scheduledTime") ? { scheduledTime: change.scheduledTime } : {}),
    ...(change.fields.includes("priority") ? { priority: change.priority! } : {}),
    ...(change.fields.includes("ideaId") ? { ideaId: change.ideaId } : {}),
  };
  const nextTodos = planner.todos.map(todo => todo.id === current.todoId || todo.eventId === current.id ? {
    ...todo,
    ...(change.fields.includes("title") ? { title: nextEvent.title } : {}),
    ...(change.fields.includes("scheduledDate") ? { dueDate: nextEvent.scheduledDate, updatedAt: now } : {}),
    ...(change.fields.includes("priority") ? { priority: nextEvent.priority } : {}),
    ...(change.fields.includes("ideaId") ? { ideaId: nextEvent.ideaId } : {}),
  } : todo);
  return {
    ok: true, changed: true,
    planner: {
      events: planner.events.map(event => event.id === current.id ? nextEvent : event),
      todos: nextTodos,
    },
    selectedDate: change.fields.includes("scheduledDate") ? nextEvent.scheduledDate : undefined,
  };
}
