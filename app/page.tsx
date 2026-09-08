import PlannerApp from "./planner-app";

// Документ всегда должен ссылаться на файлы текущей публикации. Иначе Safari
// может сохранить старый HTML и запросить уже удалённые хешированные JS-файлы.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function Home() {
  return <PlannerApp />;
}
