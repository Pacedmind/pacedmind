import "server-only";
import { deviceConfig, forgetProject, projectFolder, setAreaFolder, setProjectFolder } from "./device";
import { thisDeviceId } from "./devices";
import { repoIdentity } from "./git-remote";
import { markArea, markProject } from "./marker";
import * as repo from "./repo";
import { usesCloud } from "./scope";
import { MODE } from "./supabase";
import type { Area, Project } from "@/lib/types";

/*
 * One project on all your computers. A project is the account's, but its folder is each computer's own (device.ts), so
 * the computers tell each other which repository it is (Project.repo, git-remote.ts) and each finds its own copy by it:
 * when importing (import.ts), and here, when a project was merged into another elsewhere. An area's workspace is the
 * same (Area.repo): another computer offers its copy of the repository when you pick the area's workspace there.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keeps this computer's folders and the projects in step, now and then (background.ts) and before an import:
 * - a project with a folder here but no repository yet gets its folder's, for the other computers;
 * - a folder here whose project is gone, merged into another on another computer say, goes to the one project of the
 *   same repository that has no folder here yet.
 */
export async function linkProjects() {
  if (MODE !== "desktop") return;
  const projects = await repo.listAllProjects();
  for (const p of projects) {
    const found = p.folder && !p.repo ? repoIdentity(p.folder) : null;
    if (found) {
      await repo.setProjectRepo(p.id, found);
      p.repo = found;
    }
  }
  for (const a of await repo.listAllAreas()) {
    const found = a.folder && !a.repo ? repoIdentity(a.folder) : null;
    if (found) await repo.setAreaRepo(a.id, found);
  }
  // Only folders of the data in use: the account's projects have UUIDs, this computer's own have names.
  const cloud = await usesCloud();
  const known = new Set(projects.map((p) => p.id));
  for (const [id, folder] of Object.entries(deviceConfig().folders)) {
    if (known.has(id) || UUID.test(id) !== cloud) continue;
    const found = repoIdentity(folder);
    const heirs = found ? projects.filter((p) => !p.folder && p.repo === found) : [];
    if (heirs.length !== 1 || setProjectFolder(heirs[0].id, folder)) continue;
    heirs[0].folder = folder;
    forgetProject(id);
  }
}

/**
 * Makes `folder` this computer's copy of a project you have on another computer. A project that ran only on that one
 * then runs on both: its sessions start on the computer you start them from.
 */
export async function linkFolder(project: Project, folder: string) {
  await repo.updateProject(project.id, { folder });
  if (project.deviceId && project.deviceId !== thisDeviceId()) await repo.updateProject(project.id, { deviceId: null });
  // So your other computers find their copy of it by its pacedmind.md.
  await markProject({ ...project, folder });
}

/**
 * Makes `folder` this computer's workspace of an area you have on another computer, as picking it in Settings does:
 * the area's projects without a folder here inherit it, and the area gets its repository and its pacedmind.md.
 * Returns why it couldn't, or null.
 */
export async function linkWorkspace(area: Area, folder: string): Promise<string | null> {
  const error = setAreaFolder(area.id, folder);
  if (error) return error;
  const holds = repoIdentity(folder);
  if (holds && holds !== area.repo) await repo.setAreaRepo(area.id, holds);
  await markArea({ ...area, folder });
  return null;
}

/**
 * Merges projects into `intoId` (repo.mergeProject), with what this computer keeps for them: the folder of a merged
 * project goes to `intoId` when it has none here. Merging projects pinned to different computers leaves the result on
 * none: its sessions start where you start them.
 */
export async function mergeProjects(fromIds: string[], intoId: string): Promise<{ into: Project; merged: Project[] } | { error: string }> {
  const projects = await repo.listAllProjects();
  const into = projects.find((p) => p.id === intoId);
  if (!into) return { error: "Project not found" };
  const merged = [...new Set(fromIds)].flatMap((id) => projects.find((p) => p.id === id && id !== intoId) ?? []);
  if (!merged.length) return { error: "Pick another project to merge into this one" };
  let pinned = into.deviceId;
  for (const p of merged) {
    await repo.mergeProject(p.id, intoId);
    if (pinned && p.deviceId && p.deviceId !== pinned) pinned = null;
    if (MODE !== "desktop") continue;
    const folder = projectFolder(p.id);
    forgetProject(p.id);
    if (folder && !projectFolder(intoId)) {
      try {
        await repo.updateProject(intoId, { folder });
      } catch {
        // A folder that's gone or unusable now stays behind; the project can get another in Settings.
      }
    }
  }
  if (pinned !== into.deviceId) await repo.updateProject(intoId, { deviceId: null });
  return { into, merged };
}
