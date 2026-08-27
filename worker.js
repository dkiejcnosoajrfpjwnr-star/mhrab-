/**
 * بوت حماية وإدارة مجموعات تيليجرام - Cloudflare Workers
 * ============================================================
 * يعتمد على Cloudflare KV لتخزين البيانات بشكل دائم (namespace: BOT_KV)
 * المتغيرات المطلوبة (Environment Variables / Secrets):
 *   BOT_TOKEN     -> توكن البوت من BotFather
 *   DEV_ID        -> الآيدي الرقمي الخاص بالمطور (رقم فقط بدون علامات)
 *   WEBHOOK_SECRET-> كلمة سرية اختيارية لحماية الويبهوك (يفضل ضبطها)
 *
 * راجع ملف README.md لطريقة النشر وربط الويبهوك.
 */

// ==================== أدوات مساعدة عامة ====================

const API = (env) => `https://api.telegram.org/bot${env.BOT_TOKEN}`;

async function tg(env, method, payload) {
  const res = await fetch(`${API(env)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.log("TG_ERROR", method, JSON.stringify(payload), JSON.stringify(data));
  }
  return data;
}

function sendMessage(env, chat_id, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id,
    text,
    parse_mode: "Markdown",
    ...extra,
  });
}

function answerCallback(env, callback_query_id, text = "", show_alert = false) {
  return tg(env, "answerCallbackQuery", { callback_query_id, text, show_alert });
}

function copyMessage(env, chat_id, from_chat_id, message_id, extra = {}) {
  return tg(env, "copyMessage", { chat_id, from_chat_id, message_id, ...extra });
}

// إزالة التشكيل والتطويل من النص العربي لمطابقة أدق للأوامر والردود
function normalizeArabic(text) {
  if (!text) return "";
  return text
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function mentionOf(user) {
  const name = escapeMd(user.first_name || "العضو");
  return `[${name}](tg://user?id=${user.id})`;
}

function escapeMd(s = "") {
  return s.replace(/([_*`\[\]])/g, "\\$1");
}

// ==================== طبقة التخزين (KV) ====================

async function kvGetJSON(env, key, fallback = null) {
  const v = await env.BOT_KV.get(key);
  if (!v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}
function kvSetJSON(env, key, value) {
  return env.BOT_KV.put(key, JSON.stringify(value));
}
function kvDel(env, key) {
  return env.BOT_KV.delete(key);
}

const K = {
  pending: (uid) => `pending:${uid}`,
  group: (cid) => `group:${cid}`,
  groupsIndex: () => `groups:index`,
  muted: (cid) => `muted:${cid}`,
  restricted: (cid) => `restricted:${cid}`,
  rules: (cid) => `rules:${cid}`,
  welcome: (cid) => `welcome:${cid}`,
  replies: (cid) => `replies:${cid}`,
};

async function getGroup(env, chatId) {
  return kvGetJSON(env, K.group(chatId), null);
}
async function setGroup(env, chatId, data) {
  await kvSetJSON(env, K.group(chatId), data);
}
async function addToGroupsIndex(env, chatId) {
  const idx = (await kvGetJSON(env, K.groupsIndex(), [])) || [];
  if (!idx.includes(chatId)) {
    idx.push(chatId);
    await kvSetJSON(env, K.groupsIndex(), idx);
  }
}
async function removeFromGroupsIndex(env, chatId) {
  const idx = (await kvGetJSON(env, K.groupsIndex(), [])) || [];
  await kvSetJSON(env, K.groupsIndex(), idx.filter((x) => x !== chatId));
}

// ==================== حالات الانتظار (Pending) ====================

async function setPending(env, userId, data) {
  await kvSetJSON(env, K.pending(userId), data);
}
async function getPending(env, userId) {
  return kvGetJSON(env, K.pending(userId), null);
}
async function clearPending(env, userId) {
  await kvDel(env, K.pending(userId));
}

// ==================== صلاحيات ====================

function isDev(env, userId) {
  return String(userId) === String(env.DEV_ID);
}

async function getMemberStatus(env, chatId, userId) {
  const res = await tg(env, "getChatMember", { chat_id: chatId, user_id: userId });
  if (!res.ok) return null;
  return res.result.status;
}

async function isAdminOrOwner(env, chatId, userId) {
  const status = await getMemberStatus(env, chatId, userId);
  return status === "creator" || status === "administrator";
}

function roleLabel(status) {
  return status === "creator" ? "مالك" : "مشرف";
}

// ==================== لوحات المفاتيح (Inline Keyboards) ====================

const kbStartUser = {
  inline_keyboard: [[{ text: "➕ أضفني إلى مجموعتك", url: "https://t.me/YOUR_BOT_USERNAME?startgroup=true" }]],
};

const kbStartDev = {
  inline_keyboard: [
    [{ text: "✅ تفعيل كروب", callback_data: "dev_activate" }],
    [{ text: "🗑️ حذف كروب", callback_data: "dev_deactivate" }],
  ],
};

const kbCommandsMenu = {
  inline_keyboard: [
    [{ text: "👮‍♂️ أوامر الإدارة والعقوبات", callback_data: "menu_punish" }],
    [{ text: "📜 القوانين والترحيب", callback_data: "menu_rules_welcome" }],
    [{ text: "💬 الردود التلقائية", callback_data: "menu_replies" }],
    [{ text: "⚙️ الإعدادات العامة", callback_data: "menu_settings" }],
  ],
};

const TXT_PUNISH_MENU = `┃ ✦ أوامر الإدارة والعقوبات 👮‍♂️
┃ ✧ يجب استخدام هذه الأوامر بالرد على العضو

┃ ✦ العقوبات الأساسية
┃ ✧ كتم ➖ الغاء كتم
┃ ✧ حظر ➖ الغاء حظر
┃ ✧ طرد
┃ ✧ تقييد ➖ الغاء تقييد

┃ ✦ التنظيف والإعدادات
┃ ✧ مسح 100 (يحذف آخر 100 رسالة)
┃ ✧ مسح (بالرد، يحذف الرسالة)
┃ ✧ المكتومين (لعرض قائمة المكتومين)
┃ ✧ وضع / مسح (قوانين، ترحيب، رد)
┃ ✧ المقيديين (لعرض قائمة المقيديين)`;

const TXT_RULES_WELCOME_MENU = `┃ ✦ أوامر القوانين والترحيب 📜
┃ ✧ وضع قوانين  ➖  مسح قوانين  ➖  القوانين
┃ ✧ وضع ترحيب  ➖  مسح ترحيب`;

const TXT_REPLIES_MENU = `┃ ✦ أوامر الردود التلقائية 💬
┃ ✧ وضع رد   (لإضافة رد جديد)
┃ ✧ مسح رد   (لعرض/حذف/تعديل الردود المحفوظة)`;

const TXT_SETTINGS_MENU = `┃ ✦ الإعدادات العامة ⚙️
┃ ✧ المكتومين  ➖  المقيديين
┃ ✧ اوامر  /  أوامر  /  الاوامر  (لعرض هذه القائمة)`;

// ==================== نقطة الدخول ====================

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running.", { status: 200 });
    }
    if (env.WEBHOOK_SECRET) {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK", { status: 200 });
  },
};

async function handleUpdate(update, env) {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query, env);
    if (update.my_chat_member) return await handleMyChatMember(update.my_chat_member, env);
    if (update.message) return await handleMessage(update.message, env);
  } catch (e) {
    console.log("HANDLE_ERROR", e && e.stack ? e.stack : String(e));
  }
}

// ==================== تفعيل الكروب عبر my_chat_member ====================

async function handleMyChatMember(m, env) {
  const chat = m.chat;
  const newStatus = m.new_chat_member && m.new_chat_member.status;
  if (chat.type === "group" || chat.type === "supergroup") {
    const group = await getGroup(env, chat.id);
    if (group && group.pendingActivation && newStatus === "administrator") {
      const admins = await tg(env, "getChatAdministrators", { chat_id: chat.id });
      const adminCount = admins.ok ? admins.result.length : 0;
      await setGroup(env, chat.id, {
        activated: true,
        pendingActivation: false,
        title: chat.title || "",
        adminCount,
      });
      await addToGroupsIndex(env, chat.id);
      await sendMessage(
        env,
        chat.id,
        `✅ تم تفعيل الكروب بنجاح!\n↢ تم حفظ عدد المشرفين وتخزينهم.\n↢ البوت الآن جاهز لحماية المجموعة .`
      );
    }
  }
}

// ==================== الأزرار (Callback Query) ====================

async function handleCallback(cq, env) {
  const data = cq.data;
  const from = cq.from;
  const chatId = cq.message.chat.id;

  if (data === "dev_activate") {
    if (!isDev(env, from.id)) return answerCallback(env, cq.id, "غير مصرح لك.", true);
    await setPending(env, from.id, { type: "dev_activate_group" });
    await answerCallback(env, cq.id);
    return sendMessage(env, chatId, "┃ ✦ ارسل رابط او ايدي الكروب الذي تريد تفعيله");
  }

  if (data === "dev_deactivate") {
    if (!isDev(env, from.id)) return answerCallback(env, cq.id, "غير مصرح لك.", true);
    await setPending(env, from.id, { type: "dev_deactivate_group" });
    await answerCallback(env, cq.id);
    return sendMessage(env, chatId, "┃ ✦ ارسل رابط او ايدي الكروب الذي تريد حذفه");
  }

  if (data === "menu_punish") {
    await answerCallback(env, cq.id);
    return sendMessage(env, chatId, TXT_PUNISH_MENU);
  }
  if (data === "menu_rules_welcome") {
    await answerCallback(env, cq.id);
    return sendMessage(env, chatId, TXT_RULES_WELCOME_MENU);
  }
  if (data === "menu_replies") {
    await answerCallback(env, cq.id);
    return sendMessage(env, chatId, TXT_REPLIES_MENU);
  }
  if (data === "menu_settings") {
    await answerCallback(env, cq.id);
    return sendMessage(env, chatId, TXT_SETTINGS_MENU);
  }

  if (data === "del_all_muted") {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return answerCallback(env, cq.id, "غير مصرح.", true);
    const list = (await kvGetJSON(env, K.muted(chatId), [])) || [];
    for (const uid of list) {
      await tg(env, "restrictChatMember", { chat_id: chatId, user_id: uid, permissions: fullPermissions() });
    }
    await kvDel(env, K.muted(chatId));
    await answerCallback(env, cq.id, "تم حذف الكل");
    return sendMessage(env, chatId, "✅ تم إلغاء كتم جميع الأعضاء المكتومين");
  }
  if (data === "del_all_restricted") {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return answerCallback(env, cq.id, "غير مصرح.", true);
    const list = (await kvGetJSON(env, K.restricted(chatId), [])) || [];
    for (const uid of list) {
      await tg(env, "restrictChatMember", { chat_id: chatId, user_id: uid, permissions: fullPermissions() });
    }
    await kvDel(env, K.restricted(chatId));
    await answerCallback(env, cq.id, "تم حذف الكل");
    return sendMessage(env, chatId, "✅ تم إلغاء تقييد جميع الأعضاء المقيدين");
  }

  if (data.startsWith("reply_del_")) {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return answerCallback(env, cq.id, "غير مصرح.", true);
    const idx = parseInt(data.split("_")[2], 10);
    const list = (await kvGetJSON(env, K.replies(chatId), [])) || [];
    if (list[idx]) {
      list.splice(idx, 1);
      await kvSetJSON(env, K.replies(chatId), list);
      await answerCallback(env, cq.id, "تم الحذف");
      return sendMessage(env, chatId, "✅ تم حذف الرد بنجاح");
    }
    return answerCallback(env, cq.id, "غير موجود", true);
  }
  if (data.startsWith("reply_edit_trigger_")) {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return answerCallback(env, cq.id, "غير مصرح.", true);
    const idx = parseInt(data.split("_")[3], 10);
    await setPending(env, from.id, { type: "edit_reply_trigger", chat_id: chatId, idx });
    await answerCallback(env, cq.id);
    return sendMessage(env, chatId, "✦ ارسل نص جديد للرد عليه ✦");
  }
  if (data.startsWith("reply_edit_response_")) {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return answerCallback(env, cq.id, "غير مصرح.", true);
    const idx = parseInt(data.split("_")[3], 10);
    await setPending(env, from.id, { type: "edit_reply_response", chat_id: chatId, idx });
    await answerCallback(env, cq.id);
    return sendMessage(env, chatId, "✦ ارسل رد للنص جديد ويشمل كل الميديا مثل فيديو او صورة او ملف إلى اخره ✦");
  }

  return answerCallback(env, cq.id);
}

function fullPermissions() {
  return {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false,
  };
}

function restrictedPermissions() {
  return {
    can_send_messages: true,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
  };
}

function mutedPermissions() {
  return {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
  };
}

// ==================== الرسائل ====================

async function handleMessage(msg, env) {
  const chat = msg.chat;
  const from = msg.from;
  if (!from) return;

  if (chat.type === "private") {
    return handlePrivateMessage(msg, env);
  }

  if (chat.type === "group" || chat.type === "supergroup") {
    const group = await getGroup(env, chat.id);
    if (!group || !group.activated) return;

    if (msg.new_chat_members && msg.new_chat_members.length) {
      const welcome = await kvGetJSON(env, K.welcome(chat.id), null);
      if (welcome) {
        await copyMessage(env, chat.id, welcome.from_chat_id, welcome.message_id);
      }
      return;
    }

    return handleGroupMessage(msg, env, chat, from);
  }
}

// -------------------- محادثة خاصة --------------------

async function handlePrivateMessage(msg, env) {
  const from = msg.from;
  const text = (msg.text || "").trim();

  if (text === "/start") {
    if (isDev(env, from.id)) {
      return sendMessage(env, from.id, "اهلا بك انت مطور •", { reply_markup: kbStartDev });
    }
    return sendMessage(
      env,
      from.id,
      "👋 أهلاً بك\nعملي • حماية وإدارة المجموعات.\n\n💎 للتفعيل: أضفني لمجموعتك كـ (مشرف) وارسل كلمة تفعيل.",
      { reply_markup: kbStartUser }
    );
  }

  const pending = await getPending(env, from.id);
  if (pending && isDev(env, from.id)) {
    if (pending.type === "dev_activate_group") {
      const chatId = await resolveChatIdentifier(env, text);
      if (!chatId) {
        return sendMessage(env, from.id, "⚠️ لم أتمكن من التعرف على المجموعة، تأكد من الرابط أو الآيدي.");
      }
      await setGroup(env, chatId, { activated: false, pendingActivation: true, title: "", adminCount: 0 });
      await clearPending(env, from.id);
      return sendMessage(env, from.id, "تم تفعيل الكروب يجب ان يكون مشرف في المجموعة ( )•");
    }

    if (pending.type === "dev_deactivate_group") {
      const chatId = await resolveChatIdentifier(env, text);
      if (!chatId) {
        return sendMessage(env, from.id, "⚠️ لم أتمكن من التعرف على المجموعة، تأكد من الرابط أو الآيدي.");
      }
      await kvDel(env, K.group(chatId));
      await removeFromGroupsIndex(env, chatId);
      await clearPending(env, from.id);
      return sendMessage(env, from.id, "🗑️ تم حذف الكروب من قائمة التفعيل بنجاح.");
    }
  }
}

async function resolveChatIdentifier(env, text) {
  const raw = text.trim();
  if (/^-?\d+$/.test(raw)) return raw;

  let username = null;
  const mUsername = raw.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)/i);
  if (mUsername) username = mUsername[1];
  else if (raw.startsWith("@")) username = raw.slice(1);

  if (username) {
    const res = await tg(env, "getChat", { chat_id: `@${username}` });
    if (res.ok) return res.result.id;
  }
  return null;
}

// -------------------- رسائل داخل المجموعة --------------------

async function handleGroupMessage(msg, env, chat, from) {
  const rawText = msg.text || msg.caption || "";
  const text = normalizeArabic(rawText);
  const chatId = chat.id;

  if (["امر", "اوامر", "الاوامر"].includes(text)) {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    return sendMessage(env, chatId, "اختر القسم الذي تريده:", { reply_markup: kbCommandsMenu });
  }

  if (text === "المكتومين") {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    return sendMutedOrRestrictedList(env, chatId, "muted");
  }
  if (["المقيديين", "المقيدين"].includes(text)) {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    return sendMutedOrRestrictedList(env, chatId, "restricted");
  }

  if (text === "وضع قوانين") {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    await setPending(env, from.id, { type: "set_rules", chat_id: chatId });
    return sendMessage(env, chatId, "┃ ✦ ارسل القوانين التي تريد وضعها\n┃ ✧ ثم ارسل كلمة القوانين لتراها");
  }
  if (text === "مسح قوانين") {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    await kvDel(env, K.rules(chatId));
    return sendMessage(env, chatId, "✓ تم مسح القوانين");
  }
  if (text === "القوانين") {
    const rules = await kvGetJSON(env, K.rules(chatId), null);
    if (!rules) return sendMessage(env, chatId, "لا توجد قوانين محفوظة حاليًا.");
    return copyMessage(env, chatId, rules.from_chat_id, rules.message_id);
  }

  if (text === "وضع ترحيب") {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    await setPending(env, from.id, { type: "set_welcome", chat_id: chatId });
    return sendMessage(env, chatId, "✦ ارسل كليشة الترحيب");
  }
  if (text === "مسح ترحيب") {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    await kvDel(env, K.welcome(chatId));
    return sendMessage(env, chatId, "✓ تم مسح الترحيب");
  }

  if (text === "وضع رد") {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    await setPending(env, from.id, { type: "set_reply_trigger", chat_id: chatId });
    return sendMessage(env, chatId, "✦ ارسل نص للرد عليه ✦");
  }
  if (text === "مسح رد") {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    return sendRepliesList(env, chatId);
  }

  if (msg.reply_to_message && /^\d+$/.test(rawText.trim())) {
    const isListMsg = msg.reply_to_message.text && msg.reply_to_message.text.includes("قائمة الردود");
    if (isListMsg) {
      if (!(await isAdminOrOwner(env, chatId, from.id))) return;
      const idx = parseInt(rawText.trim(), 10) - 1;
      const list = (await kvGetJSON(env, K.replies(chatId), [])) || [];
      const item = list[idx];
      if (!item) return sendMessage(env, chatId, "⚠️ رقم غير موجود في القائمة.");
      await sendMessage(env, chatId, `1- نص الرد:\n${item.trigger}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "🗑️ حذف", callback_data: `reply_del_${idx}` },
            { text: "✏️ تعديل", callback_data: `reply_edit_trigger_${idx}` },
          ]],
        },
      });
      await sendMessage(env, chatId, `رد للنص: ${item.preview}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "🗑️ حذف", callback_data: `reply_del_${idx}` },
            { text: "✏️ تعديل", callback_data: `reply_edit_response_${idx}` },
          ]],
        },
      });
      return;
    }
  }

  const pending = await getPending(env, from.id);
  if (pending && pending.chat_id === chatId) {
    if (pending.type === "set_rules") {
      await kvSetJSON(env, K.rules(chatId), { from_chat_id: chatId, message_id: msg.message_id });
      await clearPending(env, from.id);
      return sendMessage(env, chatId, "✓ تم حفظ القوانين", { reply_to_message_id: msg.message_id });
    }
    if (pending.type === "set_welcome") {
      await kvSetJSON(env, K.welcome(chatId), { from_chat_id: chatId, message_id: msg.message_id });
      await clearPending(env, from.id);
      return sendMessage(env, chatId, "✓ تم حفظ الترحيب", { reply_to_message_id: msg.message_id });
    }
    if (pending.type === "set_reply_trigger") {
      await setPending(env, from.id, {
        type: "set_reply_response",
        chat_id: chatId,
        trigger: rawText,
        normalizedTrigger: normalizeArabic(rawText),
      });
      return sendMessage(env, chatId, "✦ ارسل رد للنص ويشمل كل الميديا مثل فيديو او صورة او ملف إلى اخره ✦");
    }
    if (pending.type === "set_reply_response") {
      const list = (await kvGetJSON(env, K.replies(chatId), [])) || [];
      list.push({
        trigger: pending.trigger,
        normalizedTrigger: pending.normalizedTrigger,
        from_chat_id: chatId,
        message_id: msg.message_id,
        preview: previewOf(msg),
      });
      await kvSetJSON(env, K.replies(chatId), list);
      await clearPending(env, from.id);
      return sendMessage(env, chatId, "✓ تم حفظ الرد بنجاح");
    }
    if (pending.type === "edit_reply_trigger") {
      const list = (await kvGetJSON(env, K.replies(chatId), [])) || [];
      if (list[pending.idx]) {
        list[pending.idx].trigger = rawText;
        list[pending.idx].normalizedTrigger = normalizeArabic(rawText);
        await kvSetJSON(env, K.replies(chatId), list);
      }
      await clearPending(env, from.id);
      return sendMessage(env, chatId, "✓ تم تحديث نص الرد");
    }
    if (pending.type === "edit_reply_response") {
      const list = (await kvGetJSON(env, K.replies(chatId), [])) || [];
      if (list[pending.idx]) {
        list[pending.idx].from_chat_id = chatId;
        list[pending.idx].message_id = msg.message_id;
        list[pending.idx].preview = previewOf(msg);
        await kvSetJSON(env, K.replies(chatId), list);
      }
      await clearPending(env, from.id);
      return sendMessage(env, chatId, "✓ تم تحديث الرد");
    }
  }

  if (/^مسح(\s+\d+)?$/.test(text)) {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    const parts = text.split(" ");
    if (parts.length === 2) {
      const count = Math.min(parseInt(parts[1], 10) || 0, 200);
      await deleteLastMessages(env, chatId, msg.message_id, count);
      return sendMessage(env, chatId, `✅ تم مسح (${count}) رسالة .\n👮‍♂️ بواسطة: ${mentionOf(from)}`);
    }
    if (msg.reply_to_message) {
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.reply_to_message.message_id });
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id });
      return;
    }
  }

  const punishCommands = ["كتم", "الغاء كتم", "حظر", "الغاء حظر", "طرد", "تقييد", "الغاء تقييد"];
  if (punishCommands.includes(text)) {
    if (!(await isAdminOrOwner(env, chatId, from.id))) return;
    if (!msg.reply_to_message || !msg.reply_to_message.from) {
      return sendMessage(env, chatId, "⚠️ يجب استخدام هذا الأمر بالرد على العضو.");
    }
    return handlePunishCommand(env, chatId, from, msg.reply_to_message.from, text);
  }

  if (rawText) {
    const list = (await kvGetJSON(env, K.replies(chatId), [])) || [];
    const norm = normalizeArabic(rawText);
    const match = list.find((r) => r.normalizedTrigger === norm);
    if (match) {
      await copyMessage(env, chatId, match.from_chat_id, match.message_id, { reply_to_message_id: msg.message_id });
    }
  }
}

function previewOf(msg) {
  if (msg.text) return msg.text.split(/\s+/).slice(0, 10).join(" ");
  if (msg.photo) return "صورة";
  if (msg.video) return "فيديو";
  if (msg.document) return "ملف";
  if (msg.voice) return "رسالة صوتية";
  if (msg.audio) return "صوت";
  if (msg.sticker) return "ستيكر";
  if (msg.animation) return "GIF";
  if (msg.caption) return msg.caption.split(/\s+/).slice(0, 10).join(" ");
  return "محتوى";
}

async function sendRepliesList(env, chatId) {
  const list = (await kvGetJSON(env, K.replies(chatId), [])) || [];
  if (!list.length) return sendMessage(env, chatId, "لا توجد ردود محفوظة حاليًا.");
  let out = "قائمة الردود\n";
  list.forEach((r, i) => {
    out += `${i + 1}- ${r.trigger} ࿓ ${r.preview}\n`;
  });
  return sendMessage(env, chatId, out);
}

async function sendMutedOrRestrictedList(env, chatId, kind) {
  const key = kind === "muted" ? K.muted(chatId) : K.restricted(chatId);
  const list = (await kvGetJSON(env, key, [])) || [];
  if (!list.length) {
    return sendMessage(env, chatId, kind === "muted" ? "لا يوجد أعضاء مكتومين حاليًا." : "لا يوجد أعضاء مقيدين حاليًا.");
  }
  const names = list.map((id, i) => `${i + 1}- [${id}](tg://user?id=${id})`).join("\n");
  const btnText = kind === "muted" ? "🗑️ حذف كل المكتومين" : "🗑️ حذف كل المقيديين";
  const cbData = kind === "muted" ? "del_all_muted" : "del_all_restricted";
  return sendMessage(env, chatId, names, {
    reply_markup: { inline_keyboard: [[{ text: btnText, callback_data: cbData }]] },
  });
}

async function deleteLastMessages(env, chatId, fromMessageId, count) {
  const ids = [];
  for (let i = 0; i <= count; i++) ids.push(fromMessageId - i);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await tg(env, "deleteMessages", { chat_id: chatId, message_ids: chunk }).catch(() => {});
  }
}

async function handlePunishCommand(env, chatId, actor, target, cmd) {
  const status = await getMemberStatus(env, chatId, actor.id);
  const byLine = `👮‍♂️ بواسطة: ${mentionOf(actor)} (${roleLabel(status)})`;
  const targetLine = `👤 المستهدف: ${mentionOf(target)}`;

  if (cmd === "كتم") {
    await tg(env, "restrictChatMember", { chat_id: chatId, user_id: target.id, permissions: mutedPermissions() });
    await addToList(env, K.muted(chatId), target.id);
    return sendMessage(env, chatId, `🔇 تم كتم العضو\n${targetLine}\n${byLine}`);
  }
  if (cmd === "الغاء كتم") {
    await tg(env, "restrictChatMember", { chat_id: chatId, user_id: target.id, permissions: fullPermissions() });
    await removeFromList(env, K.muted(chatId), target.id);
    return sendMessage(env, chatId, `🔊 تم إلغاء كتم العضو\n${targetLine}\n${byLine}`);
  }
  if (cmd === "حظر") {
    await tg(env, "banChatMember", { chat_id: chatId, user_id: target.id });
    return sendMessage(env, chatId, `⛔ تم حظر العضو\n${targetLine}\n${byLine}`);
  }
  if (cmd === "الغاء حظر") {
    await tg(env, "unbanChatMember", { chat_id: chatId, user_id: target.id, only_if_banned: true });
    return sendMessage(env, chatId, `✅ تم إلغاء حظر العضو\n${targetLine}\n${byLine}`);
  }
  if (cmd === "طرد") {
    await tg(env, "banChatMember", { chat_id: chatId, user_id: target.id });
    await tg(env, "unbanChatMember", { chat_id: chatId, user_id: target.id, only_if_banned: true });
    return sendMessage(env, chatId, `👢 تم طرد العضو\n${targetLine}\n${byLine}`);
  }
  if (cmd === "تقييد") {
    await tg(env, "restrictChatMember", { chat_id: chatId, user_id: target.id, permissions: restrictedPermissions() });
    await addToList(env, K.restricted(chatId), target.id);
    return sendMessage(env, chatId, `🔒 تم تقييد العضو\n${targetLine}\n${byLine}`);
  }
  if (cmd === "الغاء تقييد") {
    await tg(env, "restrictChatMember", { chat_id: chatId, user_id: target.id, permissions: fullPermissions() });
    await removeFromList(env, K.restricted(chatId), target.id);
    return sendMessage(env, chatId, `🔓 تم إلغاء تقييد العضو\n${targetLine}\n${byLine}`);
  }
}

async function addToList(env, key, value) {
  const list = (await kvGetJSON(env, key, [])) || [];
  if (!list.includes(value)) {
    list.push(value);
    await kvSetJSON(env, key, list);
  }
}
async function removeFromList(env, key, value) {
  const list = (await kvGetJSON(env, key, [])) || [];
  await kvSetJSON(env, key, list.filter((x) => x !== value));
}
