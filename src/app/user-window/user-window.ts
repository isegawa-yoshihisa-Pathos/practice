import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TaskList } from '../task-list/task-list';
import { ProjectMembers } from '../project-members/project-members';
import { NzPageHeaderModule } from 'ng-zorro-antd/page-header';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';
import { ProjectService } from '../project.service';
import { ProjectSessionService } from '../project-session.service';
import { TaskScope } from '../task-scope';
import { Firestore, collection, collectionData } from '@angular/fire/firestore';
import { map } from 'rxjs/operators';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-user-window',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TaskList,
    ProjectMembers,
    NzPageHeaderModule,
    NzButtonModule,
    NzInputModule,
  ],
  templateUrl: './user-window.html',
  styleUrl: './user-window.css',
})
export class UserWindow implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  private readonly projectService = inject(ProjectService);
  private readonly projectSession = inject(ProjectSessionService);
  private readonly firestore = inject(Firestore);
  private membershipSub?: Subscription;

  readonly privateScope: TaskScope = { kind: 'private' };

  /** 上部ナビ: プライベート vs プロジェクト欄 */
  mainTab = signal<'private' | 'project'>('private');
  activeProject = signal<{ id: string; name: string } | null>(null);

  projectTaskScope = computed<TaskScope>(() => {
    const p = this.activeProject();
    if (!p) {
      return { kind: 'private' };
    }
    return { kind: 'project', projectId: p.id };
  });

  createProjectName = '';
  createPassword = '';
  joinProjectName = '';
  joinPassword = '';

  memberships: { projectId: string; projectName: string }[] = [];

  ngOnInit(): void {
    const s = this.projectSession.load();
    this.mainTab.set(s.mainTab);
    this.activeProject.set(s.activeProject);
    this.memberships = s.projectTabsCache;

    const username = this.auth.username();
    if (!username) {
      return;
    }
    const ref = collection(this.firestore, 'accounts', username, 'projectMemberships');
    this.membershipSub = collectionData(ref, { idField: 'projectId' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => ({
            projectId: String(data['projectId'] ?? ''),
            projectName:
              typeof data['projectName'] === 'string' ? data['projectName'] : '（無題）',
          })),
        ),
      )
      .subscribe((rows) => {
        this.memberships = rows;
        this.persistSession();
      });
  }

  ngOnDestroy(): void {
    this.membershipSub?.unsubscribe();
    this.persistSession();
  }

  private persistSession(): void {
    this.projectSession.save({
      mainTab: this.mainTab(),
      activeProject: this.activeProject(),
      projectTabsCache: this.memberships,
    });
  }

  selectPrivate(): void {
    this.mainTab.set('private');
    this.persistSession();
  }

  /** 「プロジェクト」ラベル: ハブ（作成・参加）を表示 */
  selectProjectHub(): void {
    this.mainTab.set('project');
    this.activeProject.set(null);
    this.persistSession();
  }

  signOut(): void {
    this.persistSession();
    this.auth.signOut();
    void this.router.navigate(['/login']);
  }

  async onCreateProject(): Promise<void> {
    const username = this.auth.username();
    if (!username) {
      return;
    }
    try {
      const row = await this.projectService.createProject(
        this.createProjectName,
        this.createPassword,
        username,
      );
      this.createProjectName = '';
      this.createPassword = '';
      this.mainTab.set('project');
      this.activeProject.set({ id: row.projectId, name: row.projectName });
      this.persistSession();
    } catch (e) {
      alert(e instanceof Error ? e.message : '作成に失敗しました');
    }
  }

  async onJoinProject(): Promise<void> {
    const username = this.auth.username();
    if (!username) {
      return;
    }
    try {
      const row = await this.projectService.joinProject(
        this.joinProjectName,
        this.joinPassword,
        username,
      );
      this.joinProjectName = '';
      this.joinPassword = '';
      this.mainTab.set('project');
      this.activeProject.set({ id: row.projectId, name: row.projectName });
      this.persistSession();
    } catch (e) {
      alert(e instanceof Error ? e.message : '参加に失敗しました');
    }
  }

  openProject(p: { projectId: string; projectName: string }): void {
    this.mainTab.set('project');
    this.activeProject.set({ id: p.projectId, name: p.projectName });
    this.persistSession();
  }

  async onDeleteProject(): Promise<void> {
    const p = this.activeProject();
    const username = this.auth.username();
    if (!p || !username) {
      return;
    }
    if (
      !confirm(
        `プロジェクト「${p.name}」を削除します。全メンバーの参加情報とタスクが失われます。よろしいですか？`,
      )
    ) {
      return;
    }
    try {
      await this.projectService.deleteProject(p.id, username);
      this.activeProject.set(null);
      this.persistSession();
    } catch (e) {
      alert(e instanceof Error ? e.message : '削除に失敗しました');
    }
  }

  isProjectHubActive(): boolean {
    return this.mainTab() === 'project' && this.activeProject() === null;
  }

  isProjectTabActive(projectId: string): boolean {
    return this.activeProject()?.id === projectId;
  }
}
