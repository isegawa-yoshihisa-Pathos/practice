import {
  Component,
  DestroyRef,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  Firestore,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  Timestamp,
  collection,
  collectionData,
  query,
  where,
  orderBy,
  setDoc,
  serverTimestamp,
  DocumentReference,
} from '@angular/fire/firestore';
import { Storage, ref, uploadBytes, getDownloadURL } from '@angular/fire/storage';
import { map } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { AuthService } from '../auth.service';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { DEFAULT_TASK_LABEL_COLOR, TASK_COLOR_CHART } from '../task-colors';
import {
  clampTaskPriority,
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITY_OPTIONS,
} from '../task-priority';
import { TASK_RETURN_QUERY } from '../task-return-query';
import { ProjectSessionService, type TaskListViewPrefs } from '../project-session.service';
import {
  taskListViewStorageKeyFromDetailParam,
  taskScopeFromDetailRouteParam,
} from '../task-scope';
import {
  firestoreStatusFields,
  normalizeTaskStatusFromDoc,
  TASK_STATUS_OPTIONS,
  taskStatusLabel,
  type TaskStatus,
} from '../../models/task-status';
import type { TaskMessageAttachment } from '../../models/task-message';
import type { ProjectMemberRow } from '../../models/project-member';
import type { Task } from '../../models/task';
import { UserAvatar } from '../user-avatar/user-avatar';
import { MatRadioModule } from '@angular/material/radio';
import { TaskActivityLogService } from '../task-activity-log.service';
import {
  defaultScheduleDatetimeLocalNow,
  defaultScheduleDatetimeLocalOneHourLater,
  fromDatetimeLocalString,
  taskScheduleModeFromFields,
  timestampLikeToDate,
  toDatetimeLocalString,
} from '../task-schedule';

const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024;

@Component({
  selector: 'app-task-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatIconModule,
    MatRadioModule,
    UserAvatar,
  ],
  templateUrl: './task-detail.html',
  styleUrl: './task-detail.css',
})
export class TaskDetail implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly firestore = inject(Firestore);
  private readonly storage = inject(Storage);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly projectSession = inject(ProjectSessionService);
  private readonly taskActivityLog = inject(TaskActivityLogService);

  @ViewChild('chatScroll') private chatScroll?: ElementRef<HTMLDivElement>;

  readonly colorChart = TASK_COLOR_CHART;
  readonly priorityOptions = TASK_PRIORITY_OPTIONS;
  readonly assigneeNone = '';
  readonly statusOptions = TASK_STATUS_OPTIONS;

  loading = true;
  notFound = false;
  saveError: string | null = null;
  chatSendError: string | null = null;

  scopeParam = '';
  taskId = '';

  editTitle = '';
  editLabel: string = DEFAULT_TASK_LABEL_COLOR;
  editPriority = DEFAULT_TASK_PRIORITY;
  /** none | deadline | window — 締切と開始終了は同時に持たない */
  scheduleEditMode: 'none' | 'deadline' | 'window' = 'none';
  editDeadlineStr = '';
  editStartStr = '';
  editEndStr = '';
  editAssignee = '';
  editStatus: TaskStatus = 'todo';
  /** 読み込み時の進捗（完了日時・ログ用） */
  private statusAtLoad: TaskStatus = 'todo';

  /** 従来フィールド description（チャット移行前）。表示のみ */
  legacyDescription = '';

  chatMessages: {
    id: string;
    authorUserId: string;
    authorDisplayName: string;
    authorAvatarUrl: string | null;
    text: string;
    createdAt: Date | null;
    attachments: TaskMessageAttachment[];
  }[] = [];

  chatInput = '';
  sendingChat = false;
  chatAttachments: File[] = [];

  projectMembers: ProjectMemberRow[] = [];
  private membersSub?: Subscription;
  private messagesSub?: Subscription;

  /** 直下の子タスク（同一コレクション内 parentTaskId === このタスク） */
  subtasks: Task[] = [];
  subtasksExpanded = true;
  private subtasksSub?: Subscription;

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.scopeParam = params.get('scope') ?? '';
      this.taskId = params.get('taskId') ?? '';
      this.subscribeProjectMembers();
      void this.load();
    });
  }

  private subscribeProjectMembers(): void {
    this.membersSub?.unsubscribe();
    this.membersSub = undefined;
    this.projectMembers = [];
    if (this.scopeParam === 'private' || this.scopeParam.startsWith('pl-') || !this.scopeParam) {
      return;
    }
    const refCol = collection(this.firestore, 'projects', this.scopeParam, 'members');
    this.membersSub = collectionData(refCol, { idField: 'id' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => {
            const id = String(data['id'] ?? '');
            const displayName =
              typeof data['displayName'] === 'string' && data['displayName'].trim() !== ''
                ? data['displayName'].trim()
                : typeof data['username'] === 'string' && data['username'].trim() !== ''
                  ? data['username'].trim()
                  : id;
            const avatarUrl =
              typeof data['avatarUrl'] === 'string' && data['avatarUrl'].trim() !== ''
                ? data['avatarUrl'].trim()
                : null;
            return { userId: id, displayName, avatarUrl };
          }),
        ),
      )
      .subscribe((members) => {
        this.projectMembers = members.filter((m) => m.userId);
      });
  }

  /** 担当者セレクトのトリガー表示用（一覧のフィルタと同様にアバター＋表示名） */
  assigneeSelectedMember(): ProjectMemberRow | null {
    const id = this.editAssignee?.trim();
    if (!id) {
      return null;
    }
    return this.projectMembers.find((m) => m.userId === id) ?? null;
  }

  private taskDocRef(): DocumentReference | null {
    const userId = this.auth.userId();
    if (!userId || !this.taskId) {
      return null;
    }
    if (this.scopeParam === 'private') {
      return doc(this.firestore, 'accounts', userId, 'tasks', this.taskId);
    }
    if (this.scopeParam.startsWith('pl-')) {
      const listId = this.scopeParam.slice(3);
      return doc(
        this.firestore,
        'accounts',
        userId,
        'privateTaskLists',
        listId,
        'tasks',
        this.taskId,
      );
    }
    return doc(this.firestore, 'projects', this.scopeParam, 'tasks', this.taskId);
  }

  private tasksCollectionRef() {
    const userId = this.auth.userId();
    if (!userId) {
      return null;
    }
    if (this.scopeParam === 'private') {
      return collection(this.firestore, 'accounts', userId, 'tasks');
    }
    if (this.scopeParam.startsWith('pl-')) {
      const listId = this.scopeParam.slice(3);
      return collection(this.firestore, 'accounts', userId, 'privateTaskLists', listId, 'tasks');
    }
    return collection(this.firestore, 'projects', this.scopeParam, 'tasks');
  }

  private subscribeSubtasks(): void {
    this.subtasksSub?.unsubscribe();
    this.subtasksSub = undefined;
    this.subtasks = [];
    const col = this.tasksCollectionRef();
    const tid = this.taskId;
    if (!col || !tid) {
      return;
    }
    const q = query(col, where('parentTaskId', '==', tid));
    this.subtasksSub = collectionData(q, { idField: 'id' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => this.mapSubtaskDoc(data)),
        ),
        map((tasks) =>
          [...tasks].sort((a, b) => {
            const la = a.listOrderIndex ?? a.orderIndex;
            const lb = b.listOrderIndex ?? b.orderIndex;
            const na =
              typeof la === 'number' && !Number.isNaN(la) ? la : Number.MAX_SAFE_INTEGER;
            const nb =
              typeof lb === 'number' && !Number.isNaN(lb) ? lb : Number.MAX_SAFE_INTEGER;
            if (na !== nb) {
              return na - nb;
            }
            return (a.title ?? '').localeCompare(b.title ?? '');
          }),
        ),
      )
      .subscribe((tasks) => {
        this.subtasks = tasks;
      });
  }

  private mapSubtaskDoc(data: Record<string, unknown>): Task {
    const status = normalizeTaskStatusFromDoc(data);
    const title = typeof data['title'] === 'string' ? data['title'] : '';
    const label =
      typeof data['label'] === 'string' && data['label'].trim() !== '' ? data['label'] : '';
    const priority = clampTaskPriority(data['priority']);
    const rawLo = data['listOrderIndex'];
    const listOrderIndex =
      typeof rawLo === 'number' && !Number.isNaN(rawLo) ? rawLo : undefined;
    const rawOi = data['orderIndex'];
    const orderIndex =
      typeof rawOi === 'number' && !Number.isNaN(rawOi) ? rawOi : undefined;
    const rawP = data['parentTaskId'];
    const parentTaskId =
      typeof rawP === 'string' && rawP.trim() !== '' ? rawP.trim() : null;
    return {
      id: String(data['id'] ?? ''),
      title,
      label,
      status,
      priority,
      listOrderIndex,
      orderIndex,
      parentTaskId,
    } as Task;
  }

  toggleSubtasksExpanded(): void {
    this.subtasksExpanded = !this.subtasksExpanded;
  }

  hasSubtasks(): boolean {
    return this.subtasks.length > 0;
  }

  subtaskStatusLabel(s: TaskStatus): string {
    return taskStatusLabel(s);
  }

  openSubtaskDetail(st: Task): void {
    const id = st.id;
    if (!id) {
      return;
    }
    void this.router.navigate(['/task', this.scopeParam, id], {
      queryParams: this.route.snapshot.queryParams,
    });
  }

  /** 子タスク行のラベル帯色（一覧と同じく `label` の #RRGGBB） */
  subtaskLabelColor(st: Task): string {
    const c = st.label?.trim();
    return c || '#e0e0e0';
  }

  private subscribeMessages(taskRef: DocumentReference): void {
    this.messagesSub?.unsubscribe();
    const col = collection(taskRef, 'messages');
    const q = query(col, orderBy('createdAt', 'asc'));
    this.messagesSub = collectionData(q, { idField: 'id' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => {
            const raw = data['createdAt'];
            const createdAt =
              raw instanceof Timestamp
                ? raw.toDate()
                : raw instanceof Date
                  ? raw
                  : null;
            const attRaw = data['attachments'];
            const attachments: TaskMessageAttachment[] = Array.isArray(attRaw)
              ? attRaw
                  .map((a) => a as Record<string, unknown>)
                  .filter((a) => typeof a['url'] === 'string')
                  .map((a) => ({
                    kind:
                      a['kind'] === 'file' || a['kind'] === 'image'
                        ? (a['kind'] as 'image' | 'file')
                        : String(a['kind'] ?? '').startsWith('image')
                          ? 'image'
                          : 'file',
                    name: typeof a['name'] === 'string' ? a['name'] : 'file',
                    url: String(a['url']),
                  }))
              : [];
            return {
              id: String(data['id'] ?? ''),
              authorUserId:
                typeof data['authorUserId'] === 'string' ? data['authorUserId'] : '',
              authorDisplayName:
                typeof data['authorDisplayName'] === 'string'
                  ? data['authorDisplayName']
                  : '',
              authorAvatarUrl:
                typeof data['authorAvatarUrl'] === 'string'
                  ? data['authorAvatarUrl']
                  : null,
              text: typeof data['text'] === 'string' ? data['text'] : '',
              createdAt,
              attachments,
            };
          }),
        ),
      )
      .subscribe((msgs) => {
        this.chatMessages = msgs;
        this.scheduleScrollChatToBottom();
      });
  }

  private scheduleScrollChatToBottom(): void {
    queueMicrotask(() => {
      const el = this.chatScroll?.nativeElement;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.notFound = false;
    this.saveError = null;
    this.chatSendError = null;
    this.messagesSub?.unsubscribe();
    this.messagesSub = undefined;
    this.subtasksSub?.unsubscribe();
    this.subtasksSub = undefined;
    this.subtasks = [];
    this.chatMessages = [];
    this.legacyDescription = '';

    const ref = this.taskDocRef();
    if (!ref) {
      this.notFound = true;
      this.loading = false;
      return;
    }
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      this.notFound = true;
      this.loading = false;
      return;
    }
    const data = snap.data() as Record<string, unknown>;
    this.editTitle = typeof data['title'] === 'string' ? data['title'] : '';
    const lab = data['label'];
    this.editLabel =
      typeof lab === 'string' && lab.trim() !== '' ? lab : DEFAULT_TASK_LABEL_COLOR;
    const deadline = timestampLikeToDate(data['deadline']);
    const startAt = timestampLikeToDate(data['startAt']);
    const endAt = timestampLikeToDate(data['endAt']);
    const mode = taskScheduleModeFromFields(deadline, startAt, endAt);
    if (mode === 'window' && startAt && endAt) {
      this.scheduleEditMode = 'window';
      this.editStartStr = toDatetimeLocalString(startAt);
      this.editEndStr = toDatetimeLocalString(endAt);
      this.editDeadlineStr = '';
    } else if (mode === 'deadline' && deadline) {
      this.scheduleEditMode = 'deadline';
      this.editDeadlineStr = toDatetimeLocalString(deadline);
      this.editStartStr = '';
      this.editEndStr = '';
    } else {
      this.scheduleEditMode = 'none';
      this.editDeadlineStr = '';
      this.editStartStr = '';
      this.editEndStr = '';
    }
    const desc = typeof data['description'] === 'string' ? data['description'] : '';
    this.legacyDescription = desc.trim() !== '' ? desc : '';
    this.editPriority = clampTaskPriority(data['priority']);
    const rawAs = data['assignee'];
    this.editAssignee =
      typeof rawAs === 'string' && rawAs.trim() !== '' ? rawAs.trim() : '';
    this.editStatus = normalizeTaskStatusFromDoc(data);
    this.statusAtLoad = this.editStatus;
    this.subscribeMessages(ref);
    this.subscribeSubtasks();
    this.loading = false;
  }

  /** 空欄のときだけ現在／1時間後を入れる */
  onScheduleEditModeChange(mode: string): void {
    const m = mode as 'none' | 'deadline' | 'window';
    if (m === 'deadline' && !this.editDeadlineStr.trim()) {
      this.editDeadlineStr = defaultScheduleDatetimeLocalNow();
    } else if (m === 'window') {
      if (!this.editStartStr.trim()) {
        this.editStartStr = defaultScheduleDatetimeLocalNow();
      }
      if (!this.editEndStr.trim()) {
        this.editEndStr = defaultScheduleDatetimeLocalOneHourLater();
      }
    }
  }

  async save(): Promise<void> {
    this.saveError = null;
    const ref = this.taskDocRef();
    if (!ref) {
      return;
    }
    const payload: Record<string, unknown> = {
      title: this.editTitle.trim() || '（無題）',
      label: this.editLabel.trim() || DEFAULT_TASK_LABEL_COLOR,
      priority: clampTaskPriority(this.editPriority),
      ...firestoreStatusFields(this.editStatus),
    };
    if (this.scheduleEditMode === 'deadline') {
      const d = fromDatetimeLocalString(this.editDeadlineStr);
      if (d) {
        payload['deadline'] = Timestamp.fromDate(d);
      } else {
        payload['deadline'] = deleteField();
      }
      payload['startAt'] = deleteField();
      payload['endAt'] = deleteField();
    } else if (this.scheduleEditMode === 'window') {
      const s = fromDatetimeLocalString(this.editStartStr);
      const e = fromDatetimeLocalString(this.editEndStr);
      if (s && e) {
        if (e.getTime() < s.getTime()) {
          this.saveError = '終了日時は開始日時以降にしてください';
          return;
        }
        payload['startAt'] = Timestamp.fromDate(s);
        payload['endAt'] = Timestamp.fromDate(e);
      } else {
        payload['startAt'] = deleteField();
        payload['endAt'] = deleteField();
      }
      payload['deadline'] = deleteField();
    } else {
      payload['deadline'] = deleteField();
      payload['startAt'] = deleteField();
      payload['endAt'] = deleteField();
    }
    payload['updatedAt'] = serverTimestamp();
    if (this.editStatus === 'done' && this.statusAtLoad !== 'done') {
      payload['completedAt'] = serverTimestamp();
    } else if (this.editStatus !== 'done') {
      payload['completedAt'] = deleteField();
    }
    if (this.scopeParam !== 'private' && !this.scopeParam.startsWith('pl-')) {
      const a =
        typeof this.editAssignee === 'string' ? this.editAssignee.trim() : '';
      if (a) {
        payload['assignee'] = a;
      } else {
        payload['assignee'] = deleteField();
      }
    }
    try {
      await updateDoc(ref, payload);
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : '保存に失敗しました';
      return;
    }
    this.statusAtLoad = this.editStatus;
    try {
      await this.taskActivityLog.logUpdate(taskScopeFromDetailRouteParam(this.scopeParam), {
        taskId: this.taskId,
        taskTitle: this.editTitle.trim() || '（無題）',
      });
    } catch (e) {
      console.error('task activity log after save failed:', e);
    }
    this.navigateBackToTaskShell();
  }

  private chatStorageBasePath(messageId: string): string {
    const userId = this.auth.userId() ?? 'anon';
    const tid = this.taskId;
    if (this.scopeParam === 'private') {
      return `chat/acc/${userId}/tasks/${tid}/msg/${messageId}`;
    }
    if (this.scopeParam.startsWith('pl-')) {
      const listId = this.scopeParam.slice(3);
      return `chat/acc/${userId}/pl/${listId}/tasks/${tid}/msg/${messageId}`;
    }
    return `chat/proj/${this.scopeParam}/tasks/${tid}/msg/${messageId}`;
  }

  private safeFileName(name: string): string {
    return name.replace(/[^\w.\-]+/g, '_').slice(0, 180) || 'file';
  }

  onChatFilesSelected(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = input.files;
    input.value = '';
    if (!files?.length) {
      return;
    }
    const next = [...this.chatAttachments];
    for (const f of Array.from(files)) {
      if (f.size > MAX_CHAT_FILE_BYTES) {
        this.chatSendError = `「${f.name}」は 8MB 以下にしてください`;
        return;
      }
      next.push(f);
    }
    this.chatAttachments = next;
    this.chatSendError = null;
  }

  removeChatAttachment(index: number): void {
    this.chatAttachments = this.chatAttachments.filter((_, i) => i !== index);
  }

  async sendChat(): Promise<void> {
    this.chatSendError = null;
    const uid = this.auth.userId();
    const taskRef = this.taskDocRef();
    if (!uid || !taskRef) {
      return;
    }
    const text = this.chatInput.trim();
    if (!text && this.chatAttachments.length === 0) {
      return;
    }
    const col = collection(taskRef, 'messages');
    const msgRef = doc(col);
    const msgId = msgRef.id;
    this.sendingChat = true;
    try {
      const attachments: TaskMessageAttachment[] = [];
      for (const f of this.chatAttachments) {
        const path = `${this.chatStorageBasePath(msgId)}/${this.safeFileName(f.name)}`;
        const r = ref(this.storage, path);
        await uploadBytes(r, f, { contentType: f.type || 'application/octet-stream' });
        const url = await getDownloadURL(r);
        const kind: 'image' | 'file' = f.type.startsWith('image/') ? 'image' : 'file';
        attachments.push({ kind, name: f.name, url });
      }
      const dn = this.auth.displayName() ?? uid;
      const av = this.auth.avatarUrl();
      await setDoc(msgRef, {
        authorUserId: uid,
        authorDisplayName: dn,
        authorAvatarUrl: av ?? null,
        text,
        createdAt: serverTimestamp(),
        attachments,
      });
      this.chatInput = '';
      this.chatAttachments = [];
    } catch (e) {
      this.chatSendError = e instanceof Error ? e.message : '送信に失敗しました';
    } finally {
      this.sendingChat = false;
    }
  }

  onChatKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) {
      return;
    }
    ev.preventDefault();
    void this.sendChat();
  }

  /** 一覧 or カレンダーへ（開いた経路に応じてクエリを付与） */
  navigateBackToTaskShell(): void {
    const q = this.route.snapshot.queryParamMap;
    const from = q.get(TASK_RETURN_QUERY.from);
    const cal = q.get(TASK_RETURN_QUERY.cal);
    const taskView =
      from === 'calendar' ? 'calendar' : from === 'kanban' ? 'kanban' : 'list';
    const calOut =
      from === 'calendar'
        ? cal === 'week'
          ? 'week'
          : cal === 'day'
            ? 'day'
            : 'month'
        : null;
    /** グローバル URL ではなく、このタスク所属リストの保存だけを更新（タブごとに前回表示を再現） */
    const prefs: TaskListViewPrefs = {
      viewMode:
        taskView === 'calendar' ? 'calendar' : taskView === 'kanban' ? 'kanban' : 'list',
      calendarGranularity:
        calOut === 'week' || calOut === 'day' ? calOut : 'month',
      calendarViewDateIso: new Date().toISOString(),
    };
    this.projectSession.setTaskListViewPref(
      taskListViewStorageKeyFromDetailParam(this.scopeParam),
      prefs,
    );
    const queryParams: Record<string, string | null> = {
      [TASK_RETURN_QUERY.taskView]: taskView,
      [TASK_RETURN_QUERY.cal]: calOut,
    };
    void this.router.navigate(['/user-window'], { queryParams });
  }

  back(): void {
    this.navigateBackToTaskShell();
  }

  backButtonLabel(): string {
    const from = this.route.snapshot.queryParamMap.get(TASK_RETURN_QUERY.from);
    if (from === 'calendar') {
      return '← カレンダーへ戻る';
    }
    if (from === 'kanban') {
      return '← カンバンへ戻る';
    }
    return '← 一覧へ戻る';
  }

  async deleteTask(): Promise<void> {
    this.saveError = null;
    if (!confirm('このタスクを削除しますか？')) {
      return;
    }
    const ref = this.taskDocRef();
    if (!ref) {
      return;
    }
    try {
      await deleteDoc(ref);
      this.navigateBackToTaskShell();
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : '削除に失敗しました';
    }
  }

  pageTitle(): string {
    return this.editTitle.trim() || 'タスク詳細';
  }

  /** プロジェクトタスク（担当者あり）かどうか */
  isProjectTaskScope(): boolean {
    return this.scopeParam !== 'private' && !this.scopeParam.startsWith('pl-');
  }

  ngOnDestroy(): void {
    this.membersSub?.unsubscribe();
    this.messagesSub?.unsubscribe();
    this.subtasksSub?.unsubscribe();
  }
}
