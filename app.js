require('dotenv').config();
const { App } = require('@slack/bolt');
const { addTask, getTask, updateTask, listByStatus, listOpen, setStatus, getMeta, setMeta } = require('./db');

const LIST_CHANNEL = process.env.LIST_CHANNEL || null;
const MAX_ROWS = 16;

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

function dueRelative(due, today) {
  const d = new Date(due + 'T00:00:00+09:00');
  const t0 = new Date(today + 'T00:00:00+09:00');
  const diff = Math.round((d - t0) / 86400000);
  if (diff < 0) return `${-diff}日前`;
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  return `${diff}日後`;
}
// 期限切れ = 進行中かつ期日が過去（チップ色・並び順・フィルターで共通利用）
const isOverdue = (t, today) => t.status === 'open' && !!t.due && t.due < today;
function dueChip(t, today) {
  if (!t.due) return null;
  return `${isOverdue(t, today) ? '🔴' : '🟢'} 期日: ${dueRelative(t.due, today)}`;
}
// プライベート/DM/MPIM はペイロードで実名が来ず 'privategroup' 等のプレースホルダになる
const PLACEHOLDER = new Set(['privategroup', 'directmessage', 'mpim', '']);
const realName = (n) => (n && !PLACEHOLDER.has(n) ? n : null);

// 非公開タスクの内容を閲覧してよいのは担当者/追加者のみ（viewer=null のミラーは常に不可）
const canViewPrivate = (t, viewer) => !!viewer && (viewer === t.assignee || viewer === t.added_by);
const isMasked = (t, viewer) => t.channel_private === 1 && !canViewPrivate(t, viewer);

// プライベート名は閲覧者が担当者/追加者のときのみ表示。それ以外は常にマスク
function channelChip(t, viewer) {
  const name = realName(t.channel_name);
  if (t.channel_private === 1) {
    return canViewPrivate(t, viewer) && name ? `🔒 ${esc(name)}` : '🔒 プライベート';
  }
  if (!name) return null;
  const sym = t.channel_private === 0 ? '#' : '📍'; // null=不明 は 📍（公開と断定しない）
  return `${sym} ${esc(name)}`;
}

// ===== フィルター（ユーザーごとに保存） =====
const DEFAULT_FILTER = { status: 'open', due: 'all', assignee: null, added_by: null };
const getFilter = (u) => {
  try {
    const v = getMeta('filter:' + u);
    const f = v ? { ...DEFAULT_FILTER, ...JSON.parse(v) } : { ...DEFAULT_FILTER };
    // 旧仕様で保存された status:'all' 等の無効値は既定へ戻す（空リスト化を防ぐ）
    if (!STATUS_OPTS.some((o) => o.value === f.status)) f.status = DEFAULT_FILTER.status;
    return f;
  } catch (_) { return { ...DEFAULT_FILTER }; }
};
const setFilter = (u, f) => setMeta('filter:' + u, JSON.stringify(f));

const STATUS_OPTS = [
  { text: { type: 'plain_text', text: '進行中' }, value: 'open' },
  { text: { type: 'plain_text', text: 'アーカイブ済み' }, value: 'archived' },
  { text: { type: 'plain_text', text: '完了済み' }, value: 'done' },
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

const isMineOverdue = (t, viewer, today) => isOverdue(t, today) && t.assignee === viewer;

// 進行中に同一内容＋同一担当者のタスクが既にあるか
const isDuplicateOpen = (text, assignee) =>
  listOpen().some((t) => t.text === text && (t.assignee || null) === (assignee || null));

function applyFilter(filter, viewer) {
  const today = todayJST();
  let tasks = listByStatus(filter.status);
  if (filter.assignee) tasks = tasks.filter((t) => t.assignee === filter.assignee);
  if (filter.added_by) tasks = tasks.filter((t) => t.added_by === filter.added_by);
  if (filter.due === 'overdue') tasks = tasks.filter((t) => isOverdue(t, today));
  else if (filter.due === 'today') tasks = tasks.filter((t) => t.due === today);
  else if (filter.due === 'has') tasks = tasks.filter((t) => !!t.due);
  else if (filter.due === 'none') tasks = tasks.filter((t) => !t.due);

  const rank = (t) => (isMineOverdue(t, viewer, today) ? 0 : 1);
  tasks.sort((a, b) => {
    const r = rank(a) - rank(b); if (r) return r;
    const ad = a.due || '9999-99-99', bd = b.due || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return b.created_at - a.created_at;
  });
  return tasks;
}

// ===== タスク描画（ネイティブ「後で」風） =====
function taskMenu(t) {
  const opt = (text, value) => ({ text: { type: 'plain_text', text, emoji: true }, value });
  const options = t.status === 'open'
    ? [opt('✅ 完了', `done:${t.id}`), opt('✏️ 編集', `edit:${t.id}`), opt('🗄 アーカイブ', `archive:${t.id}`)]
    : [opt('↩︎ 進行中に戻す', `reopen:${t.id}`), opt('✏️ 編集', `edit:${t.id}`)];
  return { type: 'overflow', action_id: 'task_menu', options };
}

function taskBlocks(t, viewer) {
  const today = todayJST();
  const masked = isMasked(t, viewer);
  const out = [SPACER];

  const topBits = [];
  const dc = dueChip(t, today);
  if (dc) topBits.push(isMineOverdue(t, viewer, today) ? `*${dc}（自分）*` : dc);
  const cc = channelChip(t, viewer);
  if (cc) topBits.push(cc);
  if (topBits.length) out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: topBits.join('　・　') }] });

  // マスク時は本文・送信者・リンク・担当者を伏せ、操作メニューも出さない
  const section = { type: 'section' };
  if (masked) {
    section.text = { type: 'mrkdwn', text: '_🔒 プライベートチャンネルのタスク（内容は非表示）_' };
  } else {
    section.text = { type: 'mrkdwn', text: (t.msg_author ? `*<@${t.msg_author}>*\n` : '') + body(t) };
    section.accessory = taskMenu(t);
  }
  out.push(section);

  const meta = [];
  if (masked) {
    meta.push({ type: 'mrkdwn', text: `🧾 ${jdate(t.created_at)}` });
  } else {
    if (t.assignee) meta.push({ type: 'mrkdwn', text: `👤 <@${t.assignee}>` });
    meta.push({ type: 'mrkdwn', text: `🧾 <@${t.added_by}> が追加 ・ ${jdate(t.created_at)}` });
    if (t.status === 'done' && t.completed_at) meta.push({ type: 'mrkdwn', text: `✅ ${jdate(t.completed_at)}` });
    if (t.permalink) meta.push({ type: 'mrkdwn', text: `<${t.permalink}|🔗 開く>` });
  }
  out.push({ type: 'context', elements: meta });

  out.push({ type: 'divider' });
  return out;
}

// ===== ホーム描画（ヘッダーはボタン2つ＋テキスト） =====
function buildView(viewer) {
  const f = getFilter(viewer);
  const tasks = applyFilter(f, viewer);

  const fparts = [statusLabel(f.status)];
  if (f.due !== 'all') fparts.push(`期限: ${dueLabel(f.due)}`);
  if (f.assignee) fparts.push(`担当: ${f.assignee === viewer ? '自分' : `<@${f.assignee}>`}`);
  if (f.added_by) fparts.push(`追加者: <@${f.added_by}>`);
  const filtered = f.due !== 'all' || !!f.assignee || !!f.added_by;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '共有「後で」', emoji: true } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: '＋ 追加' }, style: 'primary', action_id: 'open_add_modal' },
      { type: 'button', text: { type: 'plain_text', text: filtered ? '🔎 絞り込み中' : '🔎 絞り込み' }, action_id: 'open_filter_modal' },
    ]},
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${fparts.join('　/　')}　—　${tasks.length} 件` }] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '各タスク右の ⋯ から操作　／　🔒 鍵付き ・ # 公開' }] },
    { type: 'divider' },
  ];

  if (!tasks.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_該当タスクなし_' } });
    return { type: 'home', blocks };
  }
  for (const t of tasks.slice(0, MAX_ROWS)) blocks.push(...taskBlocks(t, viewer));
  if (tasks.length > MAX_ROWS) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…他 ${tasks.length - MAX_ROWS} 件（絞り込みで表示）` }] });
  return { type: 'home', blocks };
}

// ===== チャンネルミラー（全員に見えるのでプライベート名は常にマスク） =====
async function syncChannel(client) {
  if (!LIST_CHANNEL) return;
  const today = todayJST();
  const tasks = listOpen();
  const lines = tasks.length
    ? tasks.map((t, i) => {
        const masked = isMasked(t, null); // ミラーは全員に見えるため非公開は本文・リンクを常にマスク
        const ex = [];
        if (t.assignee) ex.push(`👤<@${t.assignee}>`);
        if (t.due) ex.push((isOverdue(t, today) ? '🔴' : '🟢') + dueRelative(t.due, today));
        const cc = channelChip(t, null);
        if (cc) ex.push(cc);
        const first = masked ? '🔒 （内容は非表示）' : body(t).split('\n')[0];
        const link = masked || !t.permalink ? '' : `  <${t.permalink}|🔗>`;
        return `${i + 1}. ${first}${ex.length ? '  ' + ex.join(' ') : ''}${link}`;
      }).join('\n')
    : '_タスクなし_';
  const text = `*📌 共有「後で」（進行中 ${tasks.length}）*\n${lines}`;
  const existing = getMeta('channel_msg_ts');
  try {
    if (existing) return await client.chat.update({ channel: LIST_CHANNEL, ts: existing, text });
  } catch (_) {}
  const r = await client.chat.postMessage({ channel: LIST_CHANNEL, text });
  setMeta('channel_msg_ts', r.ts);
}

const publish = (client, user) => client.views.publish({ user_id: user, view: buildView(user) });
async function refresh(client, user) { await publish(client, user); await syncChannel(client); }

// ===== タスクモーダル（新規 / 編集） =====
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

// ===== 絞り込みモーダル（状態もここで切替） =====
async function openFilterModal(client, trigger_id, viewer) {
  const f = getFilter(viewer);
  const mineChecked = f.assignee === viewer;
  const assigneeInit = f.assignee && f.assignee !== viewer ? f.assignee : null;
  const MINE_OPT = { text: { type: 'plain_text', text: '🙋 自分の担当のみ' }, value: 'me' };

  const statusEl = { type: 'static_select', action_id: 'status_sel', options: STATUS_OPTS, initial_option: optByValue(STATUS_OPTS, f.status) };
  const dueEl = { type: 'static_select', action_id: 'due_sel', options: DUE_OPTS, initial_option: optByValue(DUE_OPTS, f.due) };
  const mineEl = { type: 'checkboxes', action_id: 'mine_chk', options: [MINE_OPT] };
  if (mineChecked) mineEl.initial_options = [MINE_OPT];
  const assigneeEl = { type: 'users_select', action_id: 'assignee_sel', placeholder: { type: 'plain_text', text: '指定なし' } };
  if (assigneeInit) assigneeEl.initial_user = assigneeInit;
  const addedEl = { type: 'users_select', action_id: 'added_sel', placeholder: { type: 'plain_text', text: '指定なし' } };
  if (f.added_by) addedEl.initial_user = f.added_by;

  await client.views.open({
    trigger_id,
    view: {
      type: 'modal', callback_id: 'filter_modal',
      title: { type: 'plain_text', text: '絞り込み' },
      submit: { type: 'plain_text', text: '適用' },
      close: { type: 'plain_text', text: 'やめる' },
      blocks: [
        { type: 'input', block_id: 'status', label: { type: 'plain_text', text: '状態' }, element: statusEl },
        { type: 'input', block_id: 'due', label: { type: 'plain_text', text: '期限' }, element: dueEl },
        { type: 'input', block_id: 'mine', optional: true, label: { type: 'plain_text', text: 'クイック' }, element: mineEl },
        { type: 'input', block_id: 'assignee', optional: true, label: { type: 'plain_text', text: '担当者' }, element: assigneeEl },
        { type: 'input', block_id: 'added', optional: true, label: { type: 'plain_text', text: '追加者' }, element: addedEl },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '担当者・追加者を空にすると解除。' }] },
      ],
    },
  });
}

// ===== ハンドラ =====
app.event('app_home_opened', async ({ event, client }) => { await publish(client, event.user); });

app.action('open_add_modal', async ({ body: b, ack, client }) => { await ack(); await openTaskModal(client, b.trigger_id, { assignee: b.user.id }); });
app.action('open_filter_modal', async ({ body: b, ack, client }) => { await ack(); await openFilterModal(client, b.trigger_id, b.user.id); });

app.view('filter_modal', async ({ view, ack, body: b, client }) => {
  await ack();
  const v = view.state.values;
  const status = v.status.status_sel.selected_option?.value || 'open';
  const due = v.due.due_sel.selected_option?.value || 'all';
  const mine = (v.mine?.mine_chk?.selected_options || []).length > 0;
  const assigneeSel = v.assignee?.assignee_sel?.selected_user || null;
  const added = v.added?.added_sel?.selected_user || null;
  // 明示的に選んだ担当者を優先。未選択時のみ「自分のみ」を適用
  const assignee = assigneeSel || (mine ? b.user.id : null);
  setFilter(b.user.id, { status, due, assignee, added_by: added });
  await publish(client, b.user.id);
});

app.shortcut('add_task_global', async ({ shortcut, ack, client }) => { await ack(); await openTaskModal(client, shortcut.trigger_id, { assignee: shortcut.user.id }); });
app.command('/later', async ({ command, ack, client, respond }) => {
  await ack();
  const text = (command.text || '').trim();
  if (text) {
    if (isDuplicateOpen(text, command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⚠️ 同じ内容のタスクが既に登録されています' });
      return;
    }
    addTask({ text, added_by: command.user_id, assignee: command.user_id });
    await refresh(client, command.user_id);
    await respond({ response_type: 'ephemeral', text: `追加: ${text}` });
  } else {
    await openTaskModal(client, command.trigger_id, { assignee: command.user_id });
  }
});
app.shortcut('save_message_to_list', async ({ shortcut, ack, client }) => {
  await ack();
  await openTaskModal(client, shortcut.trigger_id, {
    initialText: shortcut.message.text || '(本文なし)',
    assignee: shortcut.user.id,
    meta: {
      channel: shortcut.channel.id,
      channel_name: realName(shortcut.channel.name), // プレースホルダは捨てる
      msg_author: shortcut.message.user || null,
      message_ts: shortcut.message_ts,
    },
  });
});

app.action('task_menu', async ({ body: b, ack, action, client }) => {
  await ack();
  const [op, idStr] = (action.selected_option?.value || '').split(':');
  const id = Number(idStr);
  if (!id) return;
  const t = getTask(id);
  if (!t) return;
  // 非公開タスクの内容を見られない閲覧者は編集も状態変更も不可（古いビューからの操作対策）
  if (isMasked(t, b.user.id)) return;
  if (op === 'edit') {
    await openTaskModal(client, b.trigger_id, { initialText: t.text, assignee: t.assignee, due: t.due, meta: { id: t.id }, title: 'タスク編集', submit: '保存' });
    return;
  }
  const statusMap = { done: 'done', archive: 'archived', reopen: 'open' };
  if (statusMap[op]) { setStatus(id, statusMap[op]); await refresh(client, b.user.id); }
});

app.view('task_modal', async ({ view, ack, body: b, client }) => {
  const v = view.state.values;
  const text = v.task.text.value?.trim();
  const assignee = v.assignee?.user?.selected_user || null;
  const due = v.due?.date?.selected_date || null;
  if (!text) { await ack(); return; }

  let ctx = {};
  try { ctx = view.private_metadata ? JSON.parse(view.private_metadata) : {}; } catch (_) {}

  // 新規かつ手入力（メッセージ由来でない）のみ、同一内容＋同一担当者の重複を弾く。
  // メッセージ由来は元メッセージが別なら本文が同じでも別タスクとして許可。
  if (!ctx.id && !ctx.message_ts && isDuplicateOpen(text, assignee)) {
    await ack({ response_action: 'errors', errors: { task: '同じ内容・同じ担当者のタスクが既に登録されています' } });
    return;
  }
  await ack();

  if (ctx.id) { updateTask(ctx.id, { text, assignee, due }); await refresh(client, b.user.id); return; }

  let permalink = null, channel_name = ctx.channel_name || null, channel_private = null;
  if (ctx.channel && ctx.message_ts) {
    // permalink 取得とチャンネル情報取得は独立 → 並行実行
    const [permaRes, infoRes] = await Promise.allSettled([
      client.chat.getPermalink({ channel: ctx.channel, message_ts: ctx.message_ts }),
      client.conversations.info({ channel: ctx.channel }),
    ]);
    if (permaRes.status === 'fulfilled') permalink = permaRes.value.permalink;
    if (infoRes.status === 'fulfilled' && infoRes.value.channel) {
      const ch = infoRes.value.channel;
      channel_private = ch.is_private ? 1 : 0;
      if (ch.is_im) channel_name = 'DM';
      else if (ch.name) channel_name = ch.name; // 権威ある名前で上書き
    } else if (infoRes.status === 'rejected') {
      // 「読めない=bot未参加の非公開」のみ非公開扱い。一時的エラーは不明(null)のまま伏せない
      if (infoRes.reason?.data?.error === 'channel_not_found') channel_private = 1;
    }
  }
  addTask({
    text, added_by: b.user.id, assignee, due,
    channel: ctx.channel || null, channel_name, channel_private,
    msg_author: ctx.msg_author || null, message_ts: ctx.message_ts || null, permalink,
  });
  await refresh(client, b.user.id);
});

(async () => {
  await app.start();
  console.log('⚡️ 共有「後で」app 起動');
})();