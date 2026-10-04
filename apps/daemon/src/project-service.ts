import { SqliteProjectStore } from "@pippin/store";
import type { ProjectDto } from "@pippin/protocol";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
export class ProjectService {
  private readonly store: SqliteProjectStore;
  constructor(private readonly directory: string) {
    this.store = new SqliteProjectStore(directory);
  }
  list(): ProjectDto[] {
    return this.store.list();
  }
  get(id: string): ProjectDto {
    const project = this.store.get(id);
    if (!project) throw new Error("Project not found.");
    return project;
  }
  async create(name: string, sources: string[]): Promise<ProjectDto> {
    if (this.list().length >= 500) throw new Error("The project limit has been reached.");
    const projectId = randomUUID();
    if (!sources.length) {
      const folder = join(this.directory, "projects", projectId);
      await mkdir(folder, { recursive: true });
      sources = [folder];
    }
    const folders = await validateFolders(sources);
    return this.store.create({
      projectId,
      name: name.trim(),
      folders,
      createdAt: new Date().toISOString(),
    });
  }
  async update(id: string, name: string, sources: string[]): Promise<ProjectDto> {
    const project = this.get(id);
    if (!sources.length) throw new Error("Choose at least one source folder.");
    return this.store.update({
      ...project,
      name: name.trim(),
      folders: await validateFolders(sources),
    });
  }
  close(): void {
    this.store.close();
  }
}
export { pickProjectFolder } from "./project-folder-picker.js";

async function validateFolders(sources: string[]): Promise<string[]> {
  if (sources.length > 1) throw new Error("A project can have only one source folder.");
  const folders: string[] = [];
  for (const source of sources) {
    const folder = await realpath(resolve(source));
    if (!(await stat(folder)).isDirectory())
      throw new Error("A source folder must be a directory.");
    if (!folders.includes(folder)) folders.push(folder);
  }
  return folders;
}
