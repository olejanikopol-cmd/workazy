export type GoalPeriod = 'week' | 'month' | 'year';

/** Native Goal V1 mirrors useful Workazy Goal fields and adds stable local period identity. */
export type Goal = {
  id: string;
  title: string;
  description?: string;
  period: GoalPeriod;
  /** Monday YYYY-MM-DD for week, YYYY-MM for month, YYYY for year. */
  periodKey: string;
  deadline: string;
  progress: number;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GoalSnapshotV1 = {
  version: 1;
  revision: number;
  goals: readonly Goal[];
  savedAt: string;
};
