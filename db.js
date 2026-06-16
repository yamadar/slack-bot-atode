// SQLite データ層（better-sqlite3・同期API）
const Database = require('better-sqlite3');

const db = new Database(process.env.DB_PATH || 'tasks.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT    NOT NULL,
    channel     TEXT,
    message_ts  TEXT,
    permalink   TEXT,
    added_by    TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'open',   -- open / done / archived
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- マイグレーション ---
const cols = db.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
if (!cols.includes('assignee')) db.exec(`ALTER TABLE tasks ADD COLUMN assignee TEXT`);
if (!cols.includes('due')) db.exec(`ALTER TABLE tasks ADD COLUMN due TEXT`);
if (!cols.includes('completed_at')) db.exec(`ALTER TABLE tasks ADD COLUMN completed_at INTEGER`);

const stmt = {
  insert: db.prepare(`INSERT INTO tasks (text, channel, message_ts, permalink, added_by, assignee, due, created_at)
                      VALUES (@text, @channel, @message_ts, @permalink, @added_by, @assignee, @due, @created_at)`),
  get: db.prepare(`SELECT * FROM tasks WHERE id=?`),
  update: db.prepare(`UPDATE tasks SET text=?, assignee=?, due=? WHERE id=?`),
  listAll: db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`),
  listOpen: db.prepare(`SELECT * FROM tasks WHERE status='open'
                        ORDER BY (due IS NULL), due ASC, created_at DESC`),
  listClosed: db.prepare(`SELECT * FROM tasks WHERE status IN ('done','archived')
                          ORDER BY COALESCE(completed_at, created_at) DESC`),
  setStatus: db.prepare(`UPDATE tasks SET status=?, completed_at=? WHERE id=?`),
  metaGet: db.prepare(`SELECT value FROM meta WHERE key=?`),
  metaSet: db.prepare(`INSERT INTO meta (key,value) VALUES (?,?)
                       ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
};

function addTask({ text, channel = null, message_ts = null, permalink = null, added_by, assignee = null, due = null }) {
  return stmt.insert.run({ text, channel, message_ts, permalink, added_by, assignee, due, created_at: Date.now() }).lastInsertRowid;
}
const getTask = (id) => stmt.get.get(id);
const updateTask = (id, { text, assignee = null, due = null }) => stmt.update.run(text, assignee, due, id);
const listAll = () => stmt.listAll.all();
const listOpen = () => stmt.listOpen.all();
const listClosed = () => stmt.listClosed.all();
const setStatus = (id, status) => stmt.setStatus.run(status, status === 'done' ? Date.now() : null, id);
const getMeta = (k) => stmt.metaGet.get(k)?.value ?? null;
const setMeta = (k, v) => stmt.metaSet.run(k, v);

module.exports = { addTask, getTask, updateTask, listAll, listOpen, listClosed, setStatus, getMeta, setMeta };