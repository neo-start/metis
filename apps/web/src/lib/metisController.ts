import type { Project } from "~/types";

export function isMetisControllerProject(project: Pick<Project, "kind" | "cwd">): boolean {
  return project.kind === "chat" && /(?:^|[\\/])metis-console[\\/]?$/.test(project.cwd);
}
