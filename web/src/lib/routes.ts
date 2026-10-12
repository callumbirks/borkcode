export type Route =
  | { view: "home" }
  | { view: "settings" }
  | { view: "archived" }
  | { view: "project"; name: string }
  | { view: "new"; project: string }
  | { view: "file"; project: string; path: string }
  | { view: "thread"; id: string };

export function parseRoute(hash: string): Route {
  const [, view, id, sub, path] = hash.split("/");
  if (view === "project" && id && sub === "file" && path) {
    return { view: "file", project: decodeURIComponent(id), path: decodeURIComponent(path) };
  }
  if (view === "project" && id && sub === "new") return { view: "new", project: decodeURIComponent(id) };
  if (view === "project" && id) return { view: "project", name: decodeURIComponent(id) };
  if (view === "thread" && id) return { view: "thread", id };
  if (view === "settings") return { view: "settings" };
  if (view === "archived") return { view: "archived" };
  return { view: "home" };
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case "home":
      return "#/";
    case "settings":
      return "#/settings";
    case "archived":
      return "#/archived";
    case "project":
      return `#/project/${encodeURIComponent(route.name)}`;
    case "new":
      return `#/project/${encodeURIComponent(route.project)}/new`;
    case "file":
      return `#/project/${encodeURIComponent(route.project)}/file/${encodeURIComponent(route.path)}`;
    case "thread":
      return `#/thread/${route.id}`;
  }
}

/**
 * Where a project's new-thread composer keeps its draft, beside threads' drafts keyed by their
 * ids. Thread ids are UUIDs, so the prefix can never clash with one.
 */
export function newThreadDraftKey(project: string): string {
  return `new:${project}`;
}
