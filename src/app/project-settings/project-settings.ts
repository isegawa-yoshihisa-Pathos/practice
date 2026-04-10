import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Firestore, doc, getDoc } from '@angular/fire/firestore';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { ProjectMembers } from '../project-members/project-members';
import { AuthService } from '../auth.service';
import { ProjectService } from '../project.service';

@Component({
  selector: 'app-project-settings',
  standalone: true,
  imports: [CommonModule, NzButtonModule, ProjectMembers],
  templateUrl: './project-settings.html',
  styleUrl: './project-settings.css',
})
export class ProjectSettings implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly projectService = inject(ProjectService);

  projectId = '';
  projectName = '';
  loading = true;
  notFound = false;

  ngOnInit(): void {
    this.route.paramMap.subscribe((pm) => {
      this.projectId = pm.get('projectId') ?? '';
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.notFound = false;
    if (!this.projectId) {
      this.notFound = true;
      this.loading = false;
      return;
    }
    const ref = doc(this.firestore, 'projects', this.projectId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      this.notFound = true;
      this.loading = false;
      return;
    }
    const data = snap.data() as Record<string, unknown>;
    this.projectName = typeof data['name'] === 'string' ? data['name'] : '（無題）';
    this.loading = false;
  }

  back(): void {
    void this.router.navigate(['/user-window']);
  }

  async onLeaveProject(): Promise<void> {
    const username = this.auth.username();
    if (!username || !this.projectId) {
      return;
    }
    if (
      !confirm(
        `「${this.projectName}」から脱退します。タブ一覧からも消えます。あとから「参加」で再参加できます。よろしいですか？`,
      )
    ) {
      return;
    }
    try {
      await this.projectService.leaveProject(this.projectId, username);
      void this.router.navigate(['/user-window']);
    } catch (e) {
      alert(e instanceof Error ? e.message : '脱退に失敗しました');
    }
  }

  async onDeleteProject(): Promise<void> {
    const username = this.auth.username();
    if (!username || !this.projectId) {
      return;
    }
    if (
      !confirm(
        `プロジェクト「${this.projectName}」を削除します。全メンバーの参加情報とタスクが失われます。よろしいですか？`,
      )
    ) {
      return;
    }
    try {
      await this.projectService.deleteProject(this.projectId, username);
      void this.router.navigate(['/user-window']);
    } catch (e) {
      alert(e instanceof Error ? e.message : '削除に失敗しました');
    }
  }
}
