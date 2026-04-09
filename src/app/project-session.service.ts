import { Injectable } from '@angular/core';

const STORAGE_KEY = 'angular-todo-project-session';

export interface ProjectSessionState {
  mainTab: 'private' | 'project';
  activeProject: { id: string; name: string } | null;
  /** タブ表示のキャッシュ（サインアウト後もプロジェクト UI を復元する） */
  projectTabsCache: { projectId: string; projectName: string }[];
}

const defaultState = (): ProjectSessionState => ({
  mainTab: 'private',
  activeProject: null,
  projectTabsCache: [],
});

@Injectable({ providedIn: 'root' })
export class ProjectSessionService {
  load(): ProjectSessionState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return defaultState();
      }
      const parsed = JSON.parse(raw) as Partial<ProjectSessionState>;
      return {
        mainTab: parsed.mainTab === 'project' ? 'project' : 'private',
        activeProject:
          parsed.activeProject &&
          typeof parsed.activeProject.id === 'string' &&
          typeof parsed.activeProject.name === 'string'
            ? parsed.activeProject
            : null,
        projectTabsCache: Array.isArray(parsed.projectTabsCache)
          ? parsed.projectTabsCache.filter(
              (r) =>
                r &&
                typeof r.projectId === 'string' &&
                typeof r.projectName === 'string',
            )
          : [],
      };
    } catch {
      return defaultState();
    }
  }

  save(state: ProjectSessionState): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}
