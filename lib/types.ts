export type AppTab = "plan" | "goals" | "journal" | "calendar" | "tasks" | "ideas" | "finance";

export type PlanTask = {
  id: string;
  title: string;
  completed: boolean;
  date: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Assignment = {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
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
  updatedAt?: string;
};

export type JournalMediaKind = "audio" | "video";

export type TranscriptionStatus = "pending" | "processing" | "ready" | "error";

// Только метаданные: бинарное содержимое никогда не попадает в состояние планера.
export type JournalMedia = {
  id: string;
  journalEntryId: string;
  type: JournalMediaKind;
  mimeType: string;
  originalFilename?: string;
  sizeBytes: number;
  durationMs?: number;
  width?: number;
  height?: number;
  transcript?: string;
  transcriptEdited: boolean;
  transcriptionStatus: TranscriptionStatus;
  transcriptionError?: string;
  transcriptionProvider?: string;
  createdAt: string;
  updatedAt: string;
};

export type JournalEntry = {
  id: string;
  date: string;
  title?: string;
  body: string;
  mood?: string;
  tags: string[];
  // Сервер присоединяет метаданные вложений; старые записи приходят без поля.
  media?: JournalMedia[];
  createdAt?: string;
  updatedAt?: string;
};

export type CalendarEvent = {
  id: string;
  title: string;
  date: string;
  time?: string;
  note?: string;
  reminder?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type IdeaCategory = "thought" | "want" | "project" | "purchase" | "someday";

export type IdeaStatus = "new" | "thinking" | "plan" | "done" | "archive";

export type Idea = {
  id: string;
  title: string;
  description?: string;
  category: IdeaCategory;
  status: IdeaStatus;
  createdAt: string;
  updatedAt: string;
};

export type SalarySchedule = {
  id: string;
  dayOfMonth: number;
  amount: number;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type FinanceExpense = {
  id: string;
  date: string;
  amount: number;
  note?: string;
  createdAt: string;
};

export type FinanceObligationKind = "debt" | "purchase";

export type FinanceObligation = {
  id: string;
  kind: FinanceObligationKind;
  title: string;
  amount: number;
  dueDate?: string;
  reminderTime?: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FinanceState = {
  balance: number;
  salarySchedules: SalarySchedule[];
  expenses: FinanceExpense[];
  obligations: FinanceObligation[];
  updatedAt?: string;
};
