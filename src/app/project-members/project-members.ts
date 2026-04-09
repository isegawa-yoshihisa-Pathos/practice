import { Component, inject, Input, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Firestore, collection, collectionData, Timestamp } from '@angular/fire/firestore';
import { map } from 'rxjs/operators';
import { Subscription } from 'rxjs';
export interface ProjectMemberRow {
  username: string;
  joinedAt: Date | null;
}

@Component({
  selector: 'app-project-members',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './project-members.html',
  styleUrl: './project-members.css',
})
export class ProjectMembers implements OnInit, OnDestroy {
  private readonly firestore = inject(Firestore);
  private sub?: Subscription;

  @Input({ required: true }) projectId!: string;

  members: ProjectMemberRow[] = [];

  ngOnInit(): void {
    const ref = collection(this.firestore, 'projects', this.projectId, 'members');
    this.sub = collectionData(ref, { idField: 'id' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => {
            const raw = data['joinedAt'];
            const joinedAt =
              raw instanceof Timestamp
                ? raw.toDate()
                : raw instanceof Date
                  ? raw
                  : null;
            const username =
              typeof data['username'] === 'string' ? data['username'] : String(data['id'] ?? '');
            return { username, joinedAt };
          }),
        ),
      )
      .subscribe((members) => {
        this.members = members;
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }
}
