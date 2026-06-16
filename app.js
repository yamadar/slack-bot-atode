require('dotenv').config();
const { App } = require('@slack/bolt');
const { addTask, getTask, updateTask, listAll, listOpen, setStatus, getMeta, setMeta } = require('./db');

const LIST_CHANNEL = process.env.LIST_CHANNEL || null;
const MAX_ROWS = 14; // ブロック上限対策

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jdate = (ms) => new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
const todayJST = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const clip = (s, n = 2900) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const SPACER = { type: 'section', text: { type: 'mrkdwn', text: '\u00A0' } };
const body = (t) => clip(t.message_ts ? t.text : esc(t.text));

// ===== フィルター（ユーザーごとに保存） =====
const DEFAULT_FILTER = { status: 'open', due: 'all', assignee: null, added_by: null };
const getFilter = (u) => { try { const v = getMeta('filter:' + u); return v ? { ...DEFAULT_FILTER, ...JSON.parse(v) } : { ...DEFAULT_FILTER }; } catch (_) { return { ...DEFAULT_FILTER }; } };
const setFilter = (u, f) => setMeta('filter:' + u, JSON.stringify(f));
const patchFilter = (u, patch) => { const f = { ...getFilter(u), ...patch }; setFilter(u, f); return f; };

const STATUS_OPTS = [
  { text: { type: 'plain_text', text: '未完了' }, value: 'open' },
  { text: { type: 'plain_text', text: '完了' }, value: 'done' },
  { text: { type: 'plain_text', text: 'アーカイブ' }, value: 'archived' },
  { text: { type: 'plain_text', text: 'すべての状態' }, value: 'all' },
];
const DUE_OPTS = [
  { text: { type: 'plain_text', text: '期限: すべて' }, value: 'all' },
  { text: { type: 'plain_text', text: '期限切れ' }, value: 'overdue' },
  { text: { type: 'plain_text', text: '今日' }, value: 'today' },
  { text: { type: 'plain_text', text: '期限あり' }, value: 'has' },
  { text: { type: 'plain_text', text: '期限なし' }, value: 'none' },
];
const optByValue = (opts, v) => opts.find((o) => o.value === v) || opts[0];
const statusLabel = (v) => optByValue(STATUS_OPTS, v).text.text;
const dueLabel = (v) => optByValue(DUE_OPTS, v).text.text;

const isOverdue = (t, today) => t.status === 'open' && t.due && t.due < today;
const isMineOverdue = (t, viewer, today) => isOverdue(t, today) && t.assignee === viewer;

function applyFilter(filter, viewer) {
  const today = todayJST();
  let tasks = listAll();
  if (filter.status !== 'all') tasks = tasks.filter((t) => t.status === filter.status);
  if (filter.assignee) tasks = tasks.filter((t) => t.assignee === filter.assignee);
  if (filter.added_by) tasks = tasks.filter((t) => t.added_by === filter.added_by);
  if (filter.due === 'overdue') tasks = tasks.filter((t) => t.due && t.due < today);
  else if (filter.due === 'today') tasks = tasks.filter((t) => t.due === today);
  else if (filter.due === 'has') tasks = tasks.filter((t) => !!t.due);
  else if (filter.due === 'none') tasks = tasks.filter((t) => !t.due);

  // 並び: 自分の期限切れ → 未完了 → その他、各内で期限昇順(なしは末尾) → 新着
  const rank = (t) => (isMineOverdue(t, viewer, today) ? 0 : t.status === 'open' ? 1 : 2);
  tasks.sort((a, b) => {
    const r = rank(a) - rank(b); if (r) return r;
    const ad = a.due || '9999-99-99', bd = b.due || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return b.created_at - a.created_at;
  });
  return tasks;
}

// ===== タスク描画 =====
function metaElements(t) {
  const today = todayJST();
  const els = [{ type: 'mrkdwn', text: t.assignee ? `👤 担当 <@${t.assignee}>` : '👤 担当 未割当' }];
  if (t.due) els.push({ type: 'mrkdwn', text: t.due < today && t.status === 'open' ? `⚠️ 期限 ${t.due}（超過）` : `📅 期限 ${t.due}` });
  els.push({ type: 'mrkdwn', text: `🧾 追加 <@${t.added_by}> ・ ${jdate(t.created_at)}` });
  if (t.status === 'done' && t.completed_at) els.push({ type: 'mrkdwn', text: `✅ 完了 ${jdate(t.completed_at)}` });
  return els;
}

function taskBlocks(t, viewer) {
  const today = todayJST();
  const out = [SPACER];

  const prefix = [];
  if (isMineOverdue(t, viewer, today)) prefix.push('🔴 *【自分・期限切れ】*');
  if (t.status === 'done') prefix.push('✅ *完了*');
  else if (t.status === 'archived') prefix.push('🗄 *アーカイブ済み*');
  const head = (prefix.length ? prefix.join('　') + '\n' : '') + body(t);
  out.push({ type: 'section', text: { type: 'mrkdwn', text: head } });

  out.push({ type: 'context', elements: metaElements(t) });
  if (t.permalink) out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${t.permalink}|🔗 元メッセージを開く>` }] });

  const buttons = t.status === 'open'
    ? [
        { type: 'button', text: { type: 'plain_text', text: '✅ 完了' }, style: 'primary', action_id: 'complete_task', value: String(t.id) },
        { type: 'button', text: { type: 'plain_text', text: '✏️ 編集' }, action_id: 'edit_task', value: String(t.id) },
        { type: 'button', text: { type: 'plain_text', text: '🗄 アーカイブ' }, action_id: 'archive_task', value: String(t.id) },
      ]
    : [
        { type: 'button', text: { type: 'plain_text', text: '↩︎ 戻す' }, action_id: 'reopen_task', value: String(t.id) },
        { type: 'button', text: { type: 'plain_text', text: '✏️ 編集' }, action_id: 'edit_task', value: String(t.id) },
      ];
  out.push({ type: 'actions', elements: buttons });
  out.push({ type: 'divider' });
  return out;
}

// ===== ホーム描画 =====
function buildView(viewer) {
  const f = getFilter(viewer);
  const tasks = applyFilter(f, viewer);

  const assigneeEl = { type: 'users_select', action_id: 'f_assignee', placeholder: { type: 'plain_text', text: '担当者で絞る' } };
  if (f.assignee) assigneeEl.initial_user = f.assignee;
  const addedEl = { type: 'users_select', action_id: 'f_added', placeholder: { type: 'plain_text', text: '追加者で絞る' } };
  if (f.added_by) addedEl.initial_user = f.added_by;

  // フィルター要約
  const parts = [`状態: ${statusLabel(f.status)}`];
  if (f.due !== 'all') parts.push(`期限: ${dueLabel(f.due)}`);
  if (f.assignee) parts.push(`担当: ${f.assignee === viewer ? '自分' : `<@${f.assignee}>`}`);
  if (f.added_by) parts.push(`追加者: <@${f.added_by}>`);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📌 共有「後で」リスト', emoji: true } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: '＋ 追加' }, style: 'primary', action_id: 'open_add_modal' },
      { type: 'button', text: { type: 'plain_text', text: '🙋 私のタスク' }, action_id: 'f_mine' },
      { type: 'button', text: { type: 'plain_text', text: '⚠️ 期限切れ' }, action_id: 'f_overdue' },
      { type: 'button', text: { type: 'plain_text', text: '🧹 絞り込み解除' }, action_id: 'f_reset' },
    ]},
    { type: 'actions', elements: [
      { type: 'static_select', action_id: 'f_status', initial_option: optByValue(STATUS_OPTS, f.status), options: STATUS_OPTS },
      { type: 'static_select', action_id: 'f_due', initial_option: optByValue(DUE_OPTS, f.due), options: DUE_OPTS },
    ]},
    { type: 'actions', elements: [assigneeEl, addedEl] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `🔎 ${parts.join('　/　')}　—　${tasks.length} 件` }] },
    { type: 'divider' },
  ];

  if (!tasks.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_該当タスクなし_' } });
    return { type: 'home', blocks };
  }
  for (const t of tasks.slice(0, MAX_ROWS)) blocks.push(...taskBlocks(t, viewer));
  if (tasks.length > MAX_ROWS) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…他 ${tasks.length - MAX_ROWS} 件（フィルターで絞り込み）` }] });
  return { type: 'home', blocks };
}

// ===== チャンネルミラー（任意・閲覧専用・未完了のみ・全体） =====
async function syncChannel(client) {
  if (!LIST_CHANNEL) return;
  const today = todayJST();
  const tasks = listOpen();
  const lines = tasks.length
    ? tasks.map((t, i) => {
        const ex = [];
        if (t.assignee) ex.push(`👤<@${t.assignee}>`);
        if (t.due) ex.push((t.due < today ? '⚠️' : '📅') + t.due);
        const first = body(t).split('\n')[0];
        const link = t.permalink ? `  <${t.permalink}|🔗>` : '';
        return `${i + 1}. ${first}${ex.length ? '  ' + ex.join(' ') : ''}${link}`;
      }).join('\n')
    : '_タスクなし_';
  const text = `*📌 共有「後で」リスト（未完了 ${tasks.length}）*\n${lines}`;
  const existing = getMeta('channel_msg_ts');
  try {
    if (existing) return await client.chat.update({ channel: LIST_CHANNEL, ts: existing, text });
  } catch (_) {}
  const r = await client.chat.postMessage({ channel: LIST_CHANNEL, text });
  setMeta('channel_msg_ts', r.ts);
}

const publish = (client, user) => client.views.publish({ user_id: user, view: buildView(user) });
async function refresh(client, user) { await publish(client, user); await syncChannel(client); }

// ===== タスクモーダル（新規 / 編集 共通） =====
async function openTaskModal(client, trigger_id, opts = {}) {
  const { initialText = '', assignee = null, due = null, meta = null, title = 'タスク追加', submit = '追加' } = opts;
  const textEl = { type: 'plain_text_input', action_id: 'text', multiline: true };
  if (initialText) textEl.initial_value = initialText;
  const userEl = { type: 'users_select', action_id: 'user', placeholder: { type: 'plain_text', text: '選択（任意）' } };
  if (assignee) userEl.initial_user = assignee;
  const dateEl = { type: 'datepicker', action_id: 'date', placeholder: { type: 'plain_text', text: '選択（任意）' } };
  if (due) dateEl.initial_date = due;

  await client.views.open({
    trigger_id,
    view: {
      type: 'modal', callback_id: 'task_modal',
      private_metadata: meta ? JSON.stringify(meta) : '',
      title: { type: 'plain_text', text: title },
      submit: { type: 'plain_text', text: submit },
      close: { type: 'plain_text', text: 'やめる' },
      blocks: [
        { type: 'input', block_id: 'task', label: { type: 'plain_text', text: '内容' }, element: textEl },
        { type: 'input', block_id: 'assignee', optional: true, label: { type: 'plain_text', text: '担当者' }, element: userEl },
        { type: 'input', block_id: 'due', optional: true, label: { type: 'plain_text', text: '期限' }, element: dateEl },
      ],
    },
  });
}

// ===== ハンドラ =====
app.event('app_home_opened', async ({ event, client }) => { await publish(client, event.user); });

// フィルター操作
app.action('f_status', async ({ body: b, ack, action, client }) => { await ack(); patchFilter(b.user.id, { status: action.selected_option.value }); await publish(client, b.user.id); });
app.action('f_due', async ({ body: b, ack, action, client }) => { await ack(); patchFilter(b.user.id, { due: action.selected_option.value }); await publish(client, b.user.id); });
app.action('f_assignee', async ({ body: b, ack, action, client }) => { await ack(); patchFilter(b.user.id, { assignee: action.selected_user }); await publish(client, b.user.id); });
app.action('f_added', async ({ body: b, ack, action, client }) => { await ack(); patchFilter(b.user.id, { added_by: action.selected_user }); await publish(client, b.user.id); });
app.action('f_mine', async ({ body: b, ack, client }) => { await ack(); patchFilter(b.user.id, { assignee: b.user.id }); await publish(client, b.user.id); });
app.action('f_overdue', async ({ body: b, ack, client }) => { await ack(); patchFilter(b.user.id, { due: 'overdue', status: 'open' }); await publish(client, b.user.id); });
app.action('f_reset', async ({ body: b, ack, client }) => { await ack(); setFilter(b.user.id, { ...DEFAULT_FILTER }); await publish(client, b.user.id); });

// 追加導線
app.shortcut('add_task_global', async ({ shortcut, ack, client }) => { await ack(); await openTaskModal(client, shortcut.trigger_id); });
app.action('open_add_modal', async ({ body: b, ack, client }) => { await ack(); await openTaskModal(client, b.trigger_id); });
app.command('/later', async ({ command, ack, client, respond }) => {
  await ack();
  const text = (command.text || '').trim();
  if (text) {
    addTask({ text, added_by: command.user_id });
    await refresh(client, command.user_id);
    await respond({ response_type: 'ephemeral', text: `追加: ${text}（担当者・期限はホームの追加/編集で設定可）` });
  } else {
    await openTaskModal(client, command.trigger_id);
  }
});
app.shortcut('save_message_to_list', async ({ shortcut, ack, client }) => {
  await ack();
  await openTaskModal(client, shortcut.trigger_id, {
    initialText: shortcut.message.text || '(本文なし)',
    meta: { channel: shortcut.channel.id, message_ts: shortcut.message_ts },
  });
});

// 編集
app.action('edit_task', async ({ body: b, ack, action, client }) => {
  await ack();
  const t = getTask(Number(action.value));
  if (!t) return;
  await openTaskModal(client, b.trigger_id, { initialText: t.text, assignee: t.assignee, due: t.due, meta: { id: t.id }, title: 'タスク編集', submit: '保存' });
});

// モーダル送信（新規 / 編集）
app.view('task_modal', async ({ view, ack, body: b, client }) => {
  await ack();
  const v = view.state.values;
  const text = v.task.text.value?.trim();
  const assignee = v.assignee?.user?.selected_user || null;
  const due = v.due?.date?.selected_date || null;
  if (!text) return;

  let ctx = {};
  try { ctx = view.private_metadata ? JSON.parse(view.private_metadata) : {}; } catch (_) {}

  if (ctx.id) { updateTask(ctx.id, { text, assignee, due }); await refresh(client, b.user.id); return; }

  let permalink = null;
  if (ctx.channel && ctx.message_ts) {
    try { permalink = (await client.chat.getPermalink({ channel: ctx.channel, message_ts: ctx.message_ts })).permalink; } catch (_) {}
  }
  addTask({ text, added_by: b.user.id, assignee, due, channel: ctx.channel || null, message_ts: ctx.message_ts || null, permalink });
  await refresh(client, b.user.id);
});

// 状態変更
app.action('complete_task', async ({ body: b, ack, action, client }) => { await ack(); setStatus(Number(action.value), 'done'); await refresh(client, b.user.id); });
app.action('archive_task', async ({ body: b, ack, action, client }) => { await ack(); setStatus(Number(action.value), 'archived'); await refresh(client, b.user.id); });
app.action('reopen_task', async ({ body: b, ack, action, client }) => { await ack(); setStatus(Number(action.value), 'open'); await refresh(client, b.user.id); });

(async () => {
  await app.start();
  console.log('⚡️ 共有「後で」app 起動');
})();