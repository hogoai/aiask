export type HomeView = "home" | "inbox" | "calendar" | "todos" | "documents";

export function getHomeView(params: Pick<URLSearchParams, "get">): HomeView {
  if (params.get("continue") === "1") return "todos";
  const view = params.get("view");
  return view === "inbox" || view === "calendar" || view === "todos" || view === "documents" ? view : "home";
}

export function homeViewUrl(view: HomeView, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("capture");
  params.delete("captureDocument");
  params.delete("continue");
  params.delete("continueCalendar");
  if (view === "home") params.delete("view");
  else params.set("view", view);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}
