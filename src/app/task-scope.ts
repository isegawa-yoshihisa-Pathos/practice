export type TaskScope =
  | { kind: 'private'; privateListId: 'default' | string }
  | { kind: 'project'; projectId: string };

/** タスク詳細 URL の :scope セグメント（既定プライベートは従来どおり `private`） */
export function taskDetailScopeParam(scope: TaskScope): string {
  if (scope.kind === 'project') {
    return scope.projectId;
  }
  return scope.privateListId === 'default' ? 'private' : `pl-${scope.privateListId}`;
}

/**
 * タスクリスト表示設定（localStorage）のスコープキー。
 * プライベートはすべて `pv:{privateListId}`（既定も `pv:default`）。プロジェクトは `p:{projectId}`。
 */
export function taskListViewStorageKey(scope: TaskScope): string {
  if (scope.kind === 'project') {
    return `p:${scope.projectId}`;
  }
  return `pv:${scope.privateListId}`;
}

/**
 * タスク詳細ルートの `:scope` パラメータ → {@link taskListViewStorageKey} と同じキー空間
 */
export function taskListViewStorageKeyFromDetailParam(scopeParam: string): string {
  const s = scopeParam?.trim() ?? '';
  if (s === '' || s === 'private') {
    return 'pv:default';
  }
  if (s.startsWith('pl-')) {
    return `pv:${s.slice(3)}`;
  }
  return `p:${s}`;
}

/** `/task/:scope/...` や `/report/:scope` の `:scope` から {@link TaskScope} を復元 */
export function taskScopeFromDetailRouteParam(scopeParam: string): TaskScope {
  const s = scopeParam?.trim() ?? '';
  if (s === '' || s === 'private') {
    return { kind: 'private', privateListId: 'default' };
  }
  if (s.startsWith('pl-')) {
    return { kind: 'private', privateListId: s.slice(3) };
  }
  return { kind: 'project', projectId: s };
}
