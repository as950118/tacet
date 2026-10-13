"use server";

import { updateTag } from "next/cache";
import { projectTag } from "@/lib/data";

/** Drops the cached results of a project (and the project list), e.g. right after re-indexing it. */
export async function refreshProject(project: string) {
  updateTag(projectTag(project));
  updateTag("projects");
}
