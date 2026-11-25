import { createHash } from 'crypto';
import { serializeStore, StoreData } from './marks';

/**
 * 書籤存放模式的解析與另一端來源資料的已處理雜湊紀錄。全部是純函式，不依賴 VS Code。
 */

export type StorageMode = 'file' | 'workspaceState';

/** 指令「選擇這個專案的書籤存放位置」的選項：指定存放端，或跟隨全域／工作區設定。 */
export type WorkspaceStorageChoice = StorageMode | 'setting';

/** 每個存放模式下，已處理過（複製、合併、取代、保持空白）的另一端來源資料雜湊：資料夾鍵 → 來源內容雜湊。 */
export interface HandledOppositeSources {
  file?: Record<string, string>;
  workspaceState?: Record<string, string>;
}

/** 驗證從 workspaceState 讀出的個別選擇是否合法。 */
export function parseStorageOverride(raw: unknown): StorageMode | undefined {
  return raw === 'file' || raw === 'workspaceState' ? raw : undefined;
}

/** 取得最終生效的存放模式：這個專案的個別選擇優先，沒有時才用設定。 */
export function resolveStorageMode(workspaceOverride: StorageMode | undefined, setting: StorageMode): StorageMode {
  return workspaceOverride ?? setting;
}

/** 取得另一端存放模式（file ↔ workspaceState）。 */
export function oppositeStorageMode(mode: StorageMode): StorageMode {
  return mode === 'file' ? 'workspaceState' : 'file';
}

/** 計算書籤資料的穩定內容雜湊（serializeStore 已固定排序與欄位順序），用來判斷另一端內容是否在上次處理後又有變化。 */
export function hashStoreData(data: StoreData): string {
  return createHash('sha256').update(serializeStore(data)).digest('hex');
}

function bucketOf(state: unknown, mode: StorageMode): Record<string, string> | undefined {
  if (!state || typeof state !== 'object') {
    return undefined;
  }
  const raw = (state as Record<string, unknown>)[mode];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, string>;
}

function cloneState(state: unknown): HandledOppositeSources {
  const next: HandledOppositeSources = {};
  const fileBucket = bucketOf(state, 'file');
  if (fileBucket && Object.keys(fileBucket).length) {
    next.file = { ...fileBucket };
  }
  const wsBucket = bucketOf(state, 'workspaceState');
  if (wsBucket && Object.keys(wsBucket).length) {
    next.workspaceState = { ...wsBucket };
  }
  return next;
}

/** 這個資料夾在目前存放模式下，是否已經處理過這份相同內容（相同雜湊）的另一端來源資料。 */
export function isOppositeSourceHandled(
  state: HandledOppositeSources | undefined,
  mode: StorageMode,
  folderKey: string,
  sourceHash: string,
): boolean {
  return !!sourceHash && bucketOf(state, mode)?.[folderKey] === sourceHash;
}

/** 記錄這些資料夾在目前存放模式下已處理過對應雜湊的另一端來源資料，避免清光書籤後把舊資料重複提示回來。 */
export function markOppositeSourcesHandled(
  state: HandledOppositeSources | undefined,
  mode: StorageMode,
  hashes: Record<string, string>,
): HandledOppositeSources {
  const next = cloneState(state);
  const valid = Object.entries(hashes).filter(([, h]) => typeof h === 'string' && h.length > 0);
  if (!valid.length) {
    return next;
  }
  next[mode] = { ...(next[mode] ?? {}), ...Object.fromEntries(valid) };
  return next;
}

/** 清除某個存放模式（或指定資料夾）的已處理紀錄（主動切換到該模式時呼叫，讓新的切換可以正常提示）。 */
export function clearHandledOppositeSources(
  state: HandledOppositeSources | undefined,
  mode: StorageMode,
  folderKeys?: string[],
): HandledOppositeSources {
  const next = cloneState(state);
  if (!folderKeys) {
    delete next[mode];
    return next;
  }
  const bucket = next[mode];
  if (!bucket) {
    return next;
  }
  for (const k of folderKeys) {
    delete bucket[k];
  }
  if (!Object.keys(bucket).length) {
    delete next[mode];
  }
  return next;
}
