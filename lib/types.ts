export type AppTab = "plan" | "goals" | "journal" | "calendar" | "progress" | "ideas";

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
};

export type CalendarEvent = {
  id: string;
  title: string;
  date: string;
  time?: string;
  note?: string;
  reminder?: string;
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
