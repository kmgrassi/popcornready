import { promises as fs } from "fs";
import path from "path";
import { Clip, Project } from "./types";

// MVP persistence: a single project in a JSON file. Swap for Postgres later.
const DATA_DIR = path.join(process.cwd(), "data");
const PROJECT_FILE = path.join(DATA_DIR, "project.json");

function emptyProject(): Project {
  return {
    id: "default",
    goal: "",
    plan: null,
    timeline: null,
    clips: [],
    critic: null,
    chat: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function getProject(): Promise<Project> {
  try {
    const raw = await fs.readFile(PROJECT_FILE, "utf8");
    return JSON.parse(raw) as Project;
  } catch {
    const p = emptyProject();
    await saveProject(p);
    return p;
  }
}

export async function saveProject(p: Project): Promise<Project> {
  p.updatedAt = new Date().toISOString();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PROJECT_FILE, JSON.stringify(p, null, 2), "utf8");
  return p;
}

export async function addClip(clip: Clip): Promise<Project> {
  const p = await getProject();
  p.clips.push(clip);
  return saveProject(p);
}
