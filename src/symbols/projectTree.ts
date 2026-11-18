/** 由相對路徑清單建立資料夾樹；只有一個子資料夾且沒有檔案的層級會合併顯示（例如 `app/templates/app`）。 */
export interface DirTree {
  name: string;
  /** 相對路徑，根目錄為空字串。 */
  path: string;
  dirs: DirTree[];
  files: string[];
}

export function buildDirTree(rels: string[]): DirTree {
  const root: DirTree = { name: '', path: '', dirs: [], files: [] };
  const index = new Map<string, DirTree>([['', root]]);
  const ensure = (dirPath: string): DirTree => {
    const hit = index.get(dirPath);
    if (hit) {
      return hit;
    }
    const i = dirPath.lastIndexOf('/');
    const parent = ensure(i === -1 ? '' : dirPath.slice(0, i));
    const node: DirTree = { name: dirPath.slice(i + 1), path: dirPath, dirs: [], files: [] };
    parent.dirs.push(node);
    index.set(dirPath, node);
    return node;
  };
  for (const rel of rels) {
    const i = rel.lastIndexOf('/');
    ensure(i === -1 ? '' : rel.slice(0, i)).files.push(rel);
  }
  const sortAndCompact = (n: DirTree): DirTree => {
    n.dirs = n.dirs.map(sortAndCompact).sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.localeCompare(b));
    return n;
  };
  sortAndCompact(root);
  const compact = (n: DirTree): DirTree => {
    n.dirs = n.dirs.map((d) => {
      let cur = d;
      let name = d.name;
      while (cur.files.length === 0 && cur.dirs.length === 1) {
        cur = cur.dirs[0];
        name = `${name}/${cur.name}`;
      }
      return compact({ ...cur, name });
    });
    return n;
  };
  return compact(root);
}
