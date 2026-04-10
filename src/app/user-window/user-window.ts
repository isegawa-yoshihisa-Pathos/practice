import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TaskList } from '../task-list/task-list';
import { ProjectHub, ProjectOpenedPayload } from '../project-hub/project-hub';
import { NzPageHeaderModule } from 'ng-zorro-antd/page-header';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';
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
    TaskList,
    ProjectHub,
    NzPageHeaderModule,
    NzButtonModule,
  ],
  templateUrl: './user-window.html',
  styleUrl: './user-window.css',
})
export class UserWindow implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  private readonly projectSession = inject(ProjectSessionService);
  private readonly firestore = inject(Firestore);
  private membershipSub?: Subscription;

  readonly privateScope: TaskScope = { kind: 'private' };

  mainTab = signal<'private' | 'project'>('private');
  activeProject = signal<{ id: string; name: string } | null>(null);

  projectTaskScope = computed<TaskScope>(() => {
    const p = this.activeProject();
    if (!p) {
      return { kind: 'private' };
    }
    return { kind: 'project', projectId: p.id };
  });

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

  selectProjectHub(): void {
    this.mainTab.set('project');
    this.activeProject.set(null);
    this.persistSession();
  }

  /** 作成・参加完了時（子コンポーネントから） */
  onProjectOpened(payload: ProjectOpenedPayload): void {
    this.mainTab.set('project');
    this.activeProject.set({ id: payload.projectId, name: payload.projectName });
    this.persistSession();
  }

  signOut(): void {
    this.persistSession();
    this.auth.signOut();
    void this.router.navigate(['/login']);
  }

  openProject(p: { projectId: string; projectName: string }): void {
    this.mainTab.set('project');
    this.activeProject.set({ id: p.projectId, name: p.projectName });
    this.persistSession();
  }

  /** タブ横の ⋮ からメンバー・脱退・削除の画面へ */
  openProjectSettings(ev: Event, p: { projectId: string }): void {
    ev.stopPropagation();
    ev.preventDefault();
    void this.router.navigate(['/project', p.projectId, 'settings']);
  }

  isProjectHubActive(): boolean {
    return this.mainTab() === 'project' && this.activeProject() === null;
  }

  isProjectTabActive(projectId: string): boolean {
    return this.activeProject()?.id === projectId;
  }
}
