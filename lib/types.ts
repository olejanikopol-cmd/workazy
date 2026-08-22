export type AppTab = "plan" | "goals" | "journal" | "calendar" | "progress";

export type PlanTask = {
  id: string;
  title: string;
  completed: boolean;
  date: string;
};

export type GoalPeriod = "week" | "month" | "year";

export type Goal = {
  id: string;
  title: string;
  description?: string;
  period: GoalPeriod;
  progress: number;
  createdAt: string;
  deadline: string;
  completed: boolean;
};

export type JournalEntry = {
  id: string;
  date: string;
  title?: string;
  body: string;
  mood?: string;
  tags: string[];
};

export type CalendarEvent = {
  id: string;
  title: string;
  date: string;
  time?: string;
  note?: string;
  reminder?: string;
};
