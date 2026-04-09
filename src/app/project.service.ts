import { inject, Injectable } from '@angular/core';
import {
  Firestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} from '@angular/fire/firestore';

export interface ProjectMembershipRow {
  projectId: string;
  projectName: string;
  joinedAt: Timestamp | null;
}

@Injectable({ providedIn: 'root' })
export class ProjectService {
  private readonly firestore = inject(Firestore);

  /** プロジェクト名とパスワードから一意のドキュメント ID を生成 */
  async projectIdFromCredentials(projectName: string, password: string): Promise<string> {
    const text = `${projectName.trim()}\n${password}`;
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async createProject(projectName: string, password: string, username: string): Promise<ProjectMembershipRow> {
    const name = projectName.trim();
    if (!name || !password) {
      throw new Error('プロジェクト名とパスワードを入力してください');
    }
    const projectId = await this.projectIdFromCredentials(name, password);
    const projectRef = doc(this.firestore, 'projects', projectId);
    const existing = await getDoc(projectRef);
    if (existing.exists()) {
      throw new Error('同じプロジェクト名とパスワードの組み合わせは既に使われています。参加から入ってください。');
    }
    await setDoc(projectRef, {
      name,
      password,
      createdBy: username,
      createdAt: serverTimestamp(),
    });
    await this.addMember(projectId, username);
    await this.saveMembership(username, projectId, name);
    return { projectId, projectName: name, joinedAt: null };
  }

  async joinProject(projectName: string, password: string, username: string): Promise<ProjectMembershipRow> {
    const name = projectName.trim();
    if (!name || !password) {
      throw new Error('プロジェクト名とパスワードを入力してください');
    }
    const projectId = await this.projectIdFromCredentials(name, password);
    const projectRef = doc(this.firestore, 'projects', projectId);
    const snap = await getDoc(projectRef);
    if (!snap.exists()) {
      throw new Error('プロジェクトが見つかりません。名前とパスワードを確認してください。');
    }
    const data = snap.data() as { password?: string; name?: string };
    if (data['password'] !== password) {
      throw new Error('パスワードが正しくありません');
    }
    const displayName = typeof data['name'] === 'string' ? data['name'] : name;
    await this.addMember(projectId, username);
    await this.saveMembership(username, projectId, displayName);
    return { projectId, projectName: displayName, joinedAt: null };
  }

  private async addMember(projectId: string, username: string): Promise<void> {
    const memberRef = doc(this.firestore, 'projects', projectId, 'members', username);
    await setDoc(memberRef, {
      username,
      joinedAt: serverTimestamp(),
    });
  }

  private async saveMembership(
    username: string,
    projectId: string,
    projectName: string,
  ): Promise<void> {
    const mRef = doc(this.firestore, 'accounts', username, 'projectMemberships', projectId);
    await setDoc(mRef, {
      projectName,
      joinedAt: serverTimestamp(),
    });
  }

  /** メンバーなら誰でも削除可能。サブコレクションと全員の membership を消す。 */
  async deleteProject(projectId: string, requesterUsername: string): Promise<void> {
    const memberRef = doc(this.firestore, 'projects', projectId, 'members', requesterUsername);
    const memberSnap = await getDoc(memberRef);
    if (!memberSnap.exists()) {
      throw new Error('このプロジェクトのメンバーではありません');
    }

    const tasksCol = collection(this.firestore, 'projects', projectId, 'tasks');
    const membersCol = collection(this.firestore, 'projects', projectId, 'members');
    const [tasksSnap, membersSnap] = await Promise.all([
      getDocs(tasksCol),
      getDocs(membersCol),
    ]);

    const ops: Promise<unknown>[] = [];
    for (const d of tasksSnap.docs) {
      ops.push(deleteDoc(d.ref));
    }
    for (const d of membersSnap.docs) {
      const uname = d.id;
      ops.push(deleteDoc(d.ref));
      ops.push(
        deleteDoc(doc(this.firestore, 'accounts', uname, 'projectMemberships', projectId)),
      );
    }
    ops.push(deleteDoc(doc(this.firestore, 'projects', projectId)));
    await Promise.all(ops);
  }
}
