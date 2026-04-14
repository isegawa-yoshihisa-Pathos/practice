import { inject, Injectable } from '@angular/core';
import { AuthService } from './auth.service';

/** 旧：全ユーザー共通（切り替え時に前ユーザーの画面状態が残る問題があった） */
const LEGACY_STORAGE_KEY = 'angular-todo-project-session';
const STORAGE_KEY_PREFIX = 'angular-todo-project-session:';

/** タスクリスト（タブ）ごとの表示モード（ユーザー別 localStorage） */
const TASK_LIST_VIEWS_PREFIX = 'angular-todo-task-list-views:';

export interface TaskListViewPrefs {
  viewMode: 'list' | 'calendar' | 'kanban';
  calendarGranularity: 'month' | 'week' | 'day';
  /** ISO 8601（カレンダー基準日） */
  calendarViewDateIso: string;
}

export interface ProjectSessionState {
  mainTab: 'private' | 'project';
  activeProject: { id: string; name: string } | null;
  /** タブ表示のキャッシュ（Firestore 同期前の表示用） */
  projectTabsCache: { projectId: string; projectName: string }[];
  /** 選択中のプライベートリスト（`default` は従来の `accounts/.../tasks`） */
  activePrivateListId: 'default' | string;
  /** 追加プライベートリストのタブ表示キャッシュ */
  privateListsCache: { id: string; title: string }[];
  /** 既定「プライベート」タブの表示名キャッシュ */
  defaultPrivateListLabel: string;
  /** タブ並び（Firestore と同期するまでのキャッシュ） */
  tabOrderCache: string[];
  /** タブキー → 背景色 (#RRGGBB) */
  tabColorsCache: Record<string, string>;
}

const defaultState = (): ProjectSessionState => ({
  mainTab: 'private',
  activeProject: null,
  projectTabsCache: [],
  activePrivateListId: 'default',
  privateListsCache: [],
  defaultPrivateListLabel: 'プライベート',
  tabOrderCache: [],
  tabColorsCache: {},
});

@Injectable({ providedIn: 'root' })
export class ProjectSessionService {
  private readonly auth = inject(AuthService);

  private storageKeyForUser(userId: string): string {
    return `${STORAGE_KEY_PREFIX}${userId}`;
  }

  /**
   * ログイン中ユーザーのみ永続化。未ログイン時は常に既定値。
   * 旧グローバルキーはユーザー混在のため読まず削除する。
   */
  load(): ProjectSessionState {
    const uid = this.auth.userId();
    if (!uid) {
      return defaultState();
    }
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    try {
      const raw = localStorage.getItem(this.storageKeyForUser(uid));
      if (!raw) {
        return defaultState();
      }
      const parsed = JSON.parse(raw) as Partial<ProjectSessionState>;
      const activePrivate =
        parsed.activePrivateListId === 'default' || typeof parsed.activePrivateListId === 'string'
          ? parsed.activePrivateListId
          : 'default';
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
        activePrivateListId: activePrivate,
        privateListsCache: Array.isArray(parsed.privateListsCache)
          ? parsed.privateListsCache.filter(
              (r) => r && typeof r.id === 'string' && typeof r.title === 'string',
            )
          : [],
        defaultPrivateListLabel:
          typeof parsed.defaultPrivateListLabel === 'string' &&
          parsed.defaultPrivateListLabel.trim() !== ''
            ? parsed.defaultPrivateListLabel
            : 'プライベート',
        tabOrderCache: Array.isArray(parsed.tabOrderCache)
          ? parsed.tabOrderCache.filter((x): x is string => typeof x === 'string')
          : [],
        tabColorsCache:
          parsed.tabColorsCache &&
          typeof parsed.tabColorsCache === 'object' &&
          !Array.isArray(parsed.tabColorsCache)
            ? Object.fromEntries(
                Object.entries(parsed.tabColorsCache as Record<string, unknown>).filter(
                  ([k, v]) => typeof k === 'string' && typeof v === 'string',
                ) as [string, string][],
              )
            : {},
      };
    } catch {
      return defaultState();
    }
  }

  save(state: ProjectSessionState): void {
    const uid = this.auth.userId();
    if (!uid) {
      return;
    }
    try {
      localStorage.setItem(this.storageKeyForUser(uid), JSON.stringify(state));
    } catch {
      /* quota / private mode */
    }
  }

  /** タスクリスト単位の表示設定を読み込み（未設定キーは含まない） */
  loadTaskListViewsMap(): Record<string, TaskListViewPrefs> {
    const uid = this.auth.userId();
    if (!uid) {
      return {};
    }
    try {
      const raw = localStorage.getItem(`${TASK_LIST_VIEWS_PREFIX}${uid}`);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, TaskListViewPrefs> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k !== 'string' || !v || typeof v !== 'object') {
          continue;
        }
        const o = v as Record<string, unknown>;
        const vm = o['viewMode'];
        const cg = o['calendarGranularity'];
        const iso = o['calendarViewDateIso'];
        if (
          (vm === 'list' || vm === 'calendar' || vm === 'kanban') &&
          (cg === 'month' || cg === 'week' || cg === 'day') &&
          typeof iso === 'string' &&
          iso.length > 0
        ) {
          out[k] = {
            viewMode: vm,
            calendarGranularity: cg,
            calendarViewDateIso: iso,
          };
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  getTaskListViewPref(scopeKey: string): TaskListViewPrefs | null {
    return this.loadTaskListViewsMap()[scopeKey] ?? null;
  }

  setTaskListViewPref(scopeKey: string, prefs: TaskListViewPrefs): void {
    const uid = this.auth.userId();
    if (!uid) {
      return;
    }
    try {
      const map = this.loadTaskListViewsMap();
      map[scopeKey] = prefs;
      localStorage.setItem(`${TASK_LIST_VIEWS_PREFIX}${uid}`, JSON.stringify(map));
    } catch {
      /* quota */
    }
  }
}
