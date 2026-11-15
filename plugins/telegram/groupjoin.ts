// DIVE-5368: what happens when the bot is added to a group, kept pure so it is
// tested without importing server.ts (which long-polls Telegram on import).
//
// The owner shares an agent from the Mini App ("Who can talk to {name}" →
// Add to a group, t.me/<bot>?startgroup=1). A group added by an OWNER is
// approved at once and the agent says hello. It answers when called by name, or
// every message when the app's "In groups, answer" says so (DIVE-6675:
// `groupsRequireMention`, written by `agent telegram-access groups`). A group added by
// anyone else stays in `discovered` until it is approved, as before, and its
// join line points at the app instead of a dashboard or a terminal.
// A lite client's lines never name the platform and carry no emoji (DIVE-5121).
//
// Owner is NOT "in allowFrom": the app approves guests into allowFrom so they can
// DM the agent, and a guest must not be able to put the agent, on the owner's
// account, into a group of people the owner never saw (quinn, DIVE-5368 iter 1).
// `access.owners` is the plugin's own record: the FIRST id paired through an
// owner-level path (`agent pair`, the /telegram:access skill), which both drop
// approved/<id> (the app's guest approve never does), plus any id added with
// `/telegram:access owner add` (DIVE-5867: a later pairing is a DM user, since
// on an OSS box clients are paired the same way). `telegram-access set`
// rewrites only dmPolicy/allowFrom/groups, so the record survives the app.

import type { Lang } from './hooks/lib/lite.ts'

type From = { id: number | string; is_bot?: boolean } | undefined

const USER_ID = /^\d+$/

/** The adder is a recorded owner the bot still answers: approve the group.
 *  No record yet (`owners` undefined) → nobody is the owner: the group waits. */
export function addedByOwner(owners: readonly string[] | undefined, allowFrom: readonly string[], from: From): boolean {
  if (!from || from.is_bot || !owners) return false
  const id = String(from.id)
  return owners.includes(id) && allowFrom.includes(id)
}

/** DIVE-7250: the ids that may wake the agent in a group set to "When I call
 *  it by name" (`groupsOwnerOnly`): the recorded owners the bot still answers. */
export function groupOwnerIds(access: { owners?: string[]; allowFrom: readonly string[] }): string[] {
  return (access.owners ?? []).filter((id) => USER_ID.test(id) && access.allowFrom.includes(id))
}

/** DIVE-7250 (lodar 2026-10-29: add his agent to a shared group without anyone
 *  getting into his account through it): with `groupsOwnerOnly`, a group message
 *  from anyone but an owner is dropped, so it never reaches the agent, not even
 *  its group log, and cannot steer it when the owner does call it. */
export function ownerOnlyDrops(
  access: { owners?: string[]; allowFrom: readonly string[]; groupsOwnerOnly?: boolean },
  senderId: string,
): boolean {
  return access.groupsOwnerOnly === true && !groupOwnerIds(access).includes(senderId)
}

/** DIVE-7972 (DIVE-7963 #6): a group the owner adds lets in its OWNERS only
 *  unless the owner opened groups to everyone on purpose. Before, a new group got
 *  `allowFrom: []`, so anyone who joined through an invite link could call a sudo
 *  agent and be read as its owner. Opening groups is now an explicit act: the
 *  CLI's "In groups, answer: by name / every message" stores
 *  `groupsOwnerOnly: false` (5dive-cli DIVE-7972); "owner only" stores true; a
 *  box that never chose (the key absent) gets the safe default, as the
 *  codex/grok/pi forks already do. Groups admitted before this keep their entry. */
export function groupsOpenToMembers(access: { groupsOwnerOnly?: boolean }): boolean {
  return access.groupsOwnerOnly === false
}

/** The join's decision, on the handler's copy of access: an owner's add puts
 *  the group in `groups`; any other add leaves it only in `discovered` (written
 *  by the handler before this), waiting for approval. The new group lets in its
 *  owners only (DIVE-7972), answering by name unless the agent is set to every
 *  message; opened to everyone (`groupsOwnerOnly: false`), it answers anyone,
 *  by name unless set to every message (`groupsRequireMention: false`, DIVE-6675).
 *  Set to owner only (DIVE-7250), it answers its owners by name. */
export function admitOnJoin(
  access: { owners?: string[]; allowFrom: string[]; groups: Record<string, unknown>; groupsRequireMention?: boolean; groupsOwnerOnly?: boolean },
  chatId: string,
  from: From,
): boolean {
  const approved = !(chatId in access.groups) && addedByOwner(access.owners, access.allowFrom, from)
  if (approved)
    access.groups[chatId] = access.groupsOwnerOnly === true
      ? { requireMention: true, allowFrom: groupOwnerIds(access) }
      : groupsOpenToMembers(access)
        ? { requireMention: access.groupsRequireMention !== false, allowFrom: [] }
        : { requireMention: access.groupsRequireMention !== false, allowFrom: groupOwnerIds(access) }
  return approved
}

/** DIVE-7972: who sent a message, as the agent must weigh it.
 *  - `owner`: a recorded owner the bot still answers (groupOwnerIds). A box with
 *    no owners record yet has one pairing level, so anyone in allowFrom counts.
 *  - `guest`: someone the owner let DM the agent (in allowFrom), not an owner.
 *  - `member`: neither, e.g. anyone in a group opened to everyone. */
export type SenderRole = 'owner' | 'guest' | 'member'
export function senderRole(
  access: { owners?: string[]; allowFrom: readonly string[] },
  senderId: string,
): SenderRole {
  const owners = groupOwnerIds(access)
  const noRecord = !Array.isArray(access.owners) || access.owners.length === 0
  if (owners.includes(senderId) || (noRecord && access.allowFrom.includes(senderId))) return 'owner'
  return access.allowFrom.includes(senderId) ? 'guest' : 'member'
}

/** DIVE-5867: the owners record's format, stored beside it as `ownersSeed`.
 *  A record without it was written by the DIVE-5368 migration, which seeded
 *  EVERY allowFrom id, so it is trimmed once (nextOwners). */
export const OWNERS_SEED = 2

/** One pass over the owners record: the new list, the format to stamp, and a
 *  line for the operator when the pass decided who is (not) an owner. */
export type OwnersPass = { owners: string[]; seed: number; note: string | null }

/**
 * The owners record after one pass, or null when there is nothing to write.
 *
 * DIVE-5867: being in allowFrom, or being paired, is not an owner signal.
 * Before DIVE-5368 there was one pairing level, and on an OSS box there still
 * is (the /telegram:access skill), so a client the owner lets DM the agent is
 * paired exactly like the owner. Seeding or growing the record from that handed
 * every client the right to put the agent in a group of their choosing
 * (admitOnJoin). So:
 *
 *  - the owner is the FIRST paired user: the person who set the agent up pairs
 *    before anyone else, and allowFrom keeps pairing order (the skill and
 *    `agent pair` both append). A record with no owner takes the first one
 *    paired; a record with an owner takes no more by pairing. A second owner is
 *    added on purpose (`/telegram:access owner add <id>`).
 *  - a record from the old all-of-allowFrom seed (no `ownersSeed`) is trimmed
 *    ONCE to the first paired user it held. It never gains someone it did not
 *    hold. Narrowing is the safe direction: an owner it drops loses group
 *    auto-approve (their groups wait for approval) until added back.
 *  - each decision that leaves someone out says who, and how to undo it.
 *
 * The 5dive human registry was not used: it is empty on most boxes (adopted by
 * presence) and absent on an OSS install, which is where this was reported.
 */
export function nextOwners(
  cur: readonly string[] | undefined,
  seed: number | undefined,
  allowFrom: readonly string[],
  paired: readonly string[],
): OwnersPass | null {
  const users = allowFrom.filter((id) => USER_ID.test(id))
  const current = seed === OWNERS_SEED && cur
  const next = current ? [...cur] : users.filter((id) => !cur || cur.includes(id)).slice(0, 1)
  const notes: string[] = []
  if (!current) {
    const left = (cur ?? users).filter((id) => !next.includes(id) && users.includes(id))
    notes.push(
      `${cur ? 'owners record trimmed' : 'owners record seeded'}: owner = ` +
        (next.length ? `${next[0]} (the first paired user)` : 'nobody yet (the next pairing)') +
        '.' +
        (left.length ? ` NOT owners: ${left.join(', ')}.` : ''),
    )
  }
  const extra: string[] = []
  for (const id of paired) {
    if (!USER_ID.test(id) || next.includes(id)) continue
    if (next.length === 0) next.push(id)
    else extra.push(id)
  }
  if (extra.length) notes.push(`paired ${extra.join(', ')} as DM users, not owners (owner: ${next.join(', ')}).`)
  const anyLeftOut = extra.length > 0 || notes.some((n) => n.includes('NOT owners'))
  if (anyLeftOut) {
    notes.push(
      'They can DM the agent, but a group they add waits for approval.' +
        ' To make one an owner: /telegram:access owner add <id>.',
    )
  }
  if (current && next.length === cur.length && notes.length === 0) return null
  return { owners: next, seed: OWNERS_SEED, note: notes.length ? notes.join(' ') : null }
}

export const GROUP_STRINGS = {
  en: {
    // DIVE-5454: `replyOnly` = a non-admin bot with Group Privacy on. Telegram never
    // passes it a mention (measured 2026-10-03: topic, General, plain group), only
    // replies to its own messages and /cmd@bot. So "mention me" would be a promise
    // the bot cannot keep. DIVE-6675 (lodar 2026-10-21): she answers when called by
    // name (DIVE-6673), so the hello says that; a group set to every message is told
    // she answers its messages instead.
    // DIVE-7250: set to owner only, nobody else is told to call her.
    hello: (name: string, replyOnly = false, everyMessage = false, ownerOnly = false) =>
      replyOnly
        ? `Hi, I'm ${name}. Reply to one of my messages to ask something.`
        : ownerOnly
          ? `Hi, I'm ${name}. I answer only the person who added me.`
          : everyMessage
          ? `Hi, I'm ${name}. I answer messages in this group.`
          : `Hi, I'm ${name}. Call me by name when you need me.`,
    waiting: (name: string) => `Hi, I'm ${name}. I'll stay quiet here until my owner lets this group in.`,
    privacy:
      'Heads-up: Telegram only passes me replies to my own messages here, not mentions. ' +
      'To answer when someone mentions me, make me an admin of this group.',
  },
  ru: {
    hello: (name: string, replyOnly = false, everyMessage = false, ownerOnly = false) =>
      replyOnly
        ? `Привет, я ${name}. Чтобы задать вопрос, ответьте на одно из моих сообщений.`
        : ownerOnly
          ? `Привет, я ${name}. Я отвечаю только тому, кто меня добавил.`
          : everyMessage
          ? `Привет, я ${name}. Я отвечаю на сообщения в этой группе.`
          : `Привет, я ${name}. Позовите меня по имени, когда понадоблюсь.`,
    waiting: (name: string) => `Привет, я ${name}. Я буду молчать здесь, пока владелец не разрешит эту группу.`,
    privacy:
      'Важно: Telegram передаёт мне здесь только ответы на мои сообщения, а не упоминания. ' +
      'Чтобы я отвечал на упоминания, сделайте меня администратором группы.',
  },
} as const

/** What a stranger who DMs a lite bot is told under dmPolicy=pairing: no code,
 *  the owner lets them in from the app. Said once; the reminder is silent. */
export const ASK_OWNER: Record<Lang, string> = {
  en: "Hi! I only talk with people my owner has let in. Ask them to let you in, then message me again.",
  ru: 'Привет! Я общаюсь только с теми, кого пустил мой владелец. Попросите его разрешить вам писать мне, а потом напишите снова.',
}

/** DIVE-8513: every language the 5dive app ships, for the join lines on the
 *  default profile. Lite keeps its own two (GROUP_STRINGS, no emoji, no platform). */
export const JOIN_LANGS = ['en', 'ru', 'zh', 'tr', 'es', 'ar', 'pt', 'de', 'fr', 'ja', 'ko'] as const
export type JoinLang = (typeof JOIN_LANGS)[number]

/** The adder's Telegram language_code → a join language: 'pt-br' → 'pt',
 *  'zh-hans' → 'zh'. Anything else, or none, is English. */
export function joinLang(code?: string | null): JoinLang {
  const base = typeof code === 'string' ? code.toLowerCase().split(/[-_]/)[0] : ''
  return (JOIN_LANGS as readonly string[]).includes(base) ? (base as JoinLang) : 'en'
}

type Hello = (name: string, replyOnly?: boolean, everyMessage?: boolean, ownerOnly?: boolean) => string
type JoinText = {
  hello: Hello
  /** First half of the waiting line: the group's title and id. */
  added: (title: string, chatId: string) => string
  /** Second half on a 5dive host: where in the app the owner lets the group in,
   *  with the menu names as the app shows them in that language. */
  waitApp: (name: string) => string
  /** Second half off 5dive (the OSS fork). */
  waitTerminal: string
  privacy: string
  /** BotFather's own menu names stay English: BotFather shows them that way. */
  botfather: string
}

const hello = (hi: (name: string) => string, reply: string, owner: string, every: string, call: string): Hello =>
  (name, replyOnly = false, everyMessage = false, ownerOnly = false) =>
    `${hi(name)} ${replyOnly ? reply : ownerOnly ? owner : everyMessage ? every : call}`

/** DIVE-8513: the default profile's join lines in the adder's language (lite
 *  had this since DIVE-5121). English and Russian reuse GROUP_STRINGS' wording;
 *  the app's menu names are its own translations of "Who can talk to {name}". */
export const JOIN_STRINGS: Record<JoinLang, JoinText> = {
  en: {
    hello: GROUP_STRINGS.en.hello,
    added: (t, id) => `Hi! I've been added to "${t}" — group id: ${id}.`,
    waitApp: () => `I'll stay quiet until my owner approves this group in the 5dive app (the agent's settings → Who can talk to).`,
    waitTerminal: `I'll stay quiet until this group is approved: run /telegram:access in the agent terminal.`,
    privacy: GROUP_STRINGS.en.privacy,
    botfather: '(Or turn Group Privacy off in @BotFather → Bot Settings, then remove me and add me back.)',
  },
  ru: {
    hello: GROUP_STRINGS.ru.hello,
    added: (t, id) => `Привет! Меня добавили в «${t}» — id группы: ${id}.`,
    waitApp: (n) => `Я буду молчать, пока владелец не одобрит эту группу в приложении 5dive (настройки агента → «Кто может писать агенту ${n}»).`,
    waitTerminal: 'Я буду молчать, пока эту группу не одобрят: выполните /telegram:access в терминале агента.',
    privacy: GROUP_STRINGS.ru.privacy,
    botfather: '(Или выключите Group Privacy в @BotFather → Bot Settings, затем удалите меня из группы и добавьте снова.)',
  },
  zh: {
    hello: (name, replyOnly = false, everyMessage = false, ownerOnly = false) =>
      `你好，我是 ${name}。` +
      (replyOnly ? '要提问，请回复我的任意一条消息。'
        : ownerOnly ? '我只回复把我加进来的人。'
        : everyMessage ? '我会回复这个群里的消息。'
        : '需要我时，叫我的名字就行。'),
    added: (t, id) => `你好！我被加入了「${t}」— 群组 ID：${id}。`,
    waitApp: (n) => `在我的所有者于 5dive 应用中批准这个群组之前，我会保持安静（智能体设置 → 「谁可以和 ${n} 对话」）。`,
    waitTerminal: '在这个群组获批之前，我会保持安静：请在智能体终端中运行 /telegram:access。',
    privacy: '提示：在这里，Telegram 只把对我消息的回复传给我，不传递提及。要让我在被提及时回答，请把我设为本群管理员。',
    botfather: '（或者在 @BotFather → Bot Settings 中关闭 Group Privacy，然后把我移出群组再重新添加。）',
  },
  tr: {
    hello: hello((n) => `Merhaba, ben ${n}.`,
      'Bir şey sormak için mesajlarımdan birine yanıt verin.',
      'Yalnızca beni ekleyen kişiye yanıt veririm.',
      'Bu gruptaki mesajlara yanıt veririm.',
      'Bana ihtiyacınız olduğunda adımla seslenin.'),
    added: (t, id) => `Merhaba! "${t}" grubuna eklendim — grup kimliği: ${id}.`,
    waitApp: (n) => `Sahibim bu grubu 5dive uygulamasında onaylayana kadar sessiz kalacağım (ajan ayarları → "${n} ajanıyla kimler konuşabilir").`,
    waitTerminal: 'Bu grup onaylanana kadar sessiz kalacağım: ajan terminalinde /telegram:access komutunu çalıştırın.',
    privacy: 'Bilgi: Telegram burada bana yalnızca kendi mesajlarıma verilen yanıtları iletir, bahsetmeleri iletmez. ' +
      'Biri benden bahsettiğinde yanıt verebilmem için beni bu grubun yöneticisi yapın.',
    botfather: "(Ya da @BotFather → Bot Settings bölümünde Group Privacy'yi kapatın, sonra beni gruptan çıkarıp yeniden ekleyin.)",
  },
  es: {
    hello: hello((n) => `Hola, soy ${n}.`,
      'Para preguntarme algo, responde a uno de mis mensajes.',
      'Solo respondo a la persona que me añadió.',
      'Respondo a los mensajes de este grupo.',
      'Llámame por mi nombre cuando me necesites.'),
    added: (t, id) => `¡Hola! Me han añadido a «${t}» — id del grupo: ${id}.`,
    waitApp: (n) => `No diré nada hasta que mi propietario apruebe este grupo en la app de 5dive (ajustes del agente → «Quién puede hablar con ${n}»).`,
    waitTerminal: 'No diré nada hasta que se apruebe este grupo: ejecuta /telegram:access en el terminal del agente.',
    privacy: 'Aviso: aquí Telegram solo me pasa las respuestas a mis propios mensajes, no las menciones. ' +
      'Para que responda cuando alguien me mencione, hazme administrador de este grupo.',
    botfather: '(O desactiva Group Privacy en @BotFather → Bot Settings y luego sácame del grupo y vuelve a añadirme.)',
  },
  ar: {
    hello: hello((n) => `مرحبًا، أنا ${n}.`,
      'لطرح سؤال، رُدّ على إحدى رسائلي.',
      'أردّ فقط على الشخص الذي أضافني.',
      'أردّ على الرسائل في هذه المجموعة.',
      'نادني باسمي عندما تحتاج إليّ.'),
    added: (t, id) => `مرحبًا! تمت إضافتي إلى «${t}» — معرّف المجموعة: ${id}.`,
    // Right-to-left: the next step is to the left, so the arrow points left.
    waitApp: (n) => `سأبقى صامتًا حتى يوافق مالكي على هذه المجموعة في تطبيق 5dive (إعدادات الوكيل ← «من يمكنه التحدث إلى الوكيل ${n}»).`,
    waitTerminal: 'سأبقى صامتًا حتى تتم الموافقة على هذه المجموعة: شغّل /telegram:access في طرفية الوكيل.',
    privacy: 'تنبيه: لا يمرّر لي Telegram هنا إلا الردود على رسائلي، وليس الإشارات إليّ. ' +
      'لكي أردّ عندما يشير إليّ أحد، اجعلني مشرفًا في هذه المجموعة.',
    botfather: '(أو أوقف Group Privacy في @BotFather ← Bot Settings، ثم أزلني من المجموعة وأضفني مجددًا.)',
  },
  pt: {
    hello: hello((n) => `Oi, eu sou ${n}.`,
      'Para perguntar algo, responda a uma das minhas mensagens.',
      'Só respondo à pessoa que me adicionou.',
      'Respondo às mensagens deste grupo.',
      'Me chame pelo nome quando precisar.'),
    added: (t, id) => `Oi! Me adicionaram ao grupo "${t}" — id do grupo: ${id}.`,
    waitApp: (n) => `Vou ficar em silêncio até meu proprietário aprovar este grupo no app 5dive (configurações do agente → "Quem pode falar com o agente ${n}").`,
    waitTerminal: 'Vou ficar em silêncio até este grupo ser aprovado: execute /telegram:access no terminal do agente.',
    privacy: 'Atenção: aqui o Telegram só me repassa respostas às minhas próprias mensagens, não menções. ' +
      'Para eu responder quando alguém me mencionar, me torne administrador deste grupo.',
    botfather: '(Ou desative o Group Privacy no @BotFather → Bot Settings, depois me remova do grupo e me adicione de novo.)',
  },
  de: {
    hello: hello((n) => `Hallo, ich bin ${n}.`,
      'Antworte auf eine meiner Nachrichten, um etwas zu fragen.',
      'Ich antworte nur der Person, die mich hinzugefügt hat.',
      'Ich antworte auf Nachrichten in dieser Gruppe.',
      'Ruf mich beim Namen, wenn du mich brauchst.'),
    added: (t, id) => `Hallo! Ich wurde zu „${t}“ hinzugefügt — Gruppen-ID: ${id}.`,
    waitApp: (n) => `Ich bleibe still, bis mein Inhaber diese Gruppe in der 5dive-App freigibt (Einstellungen des Agenten → „Wer mit dem Agenten ${n} sprechen darf“).`,
    waitTerminal: 'Ich bleibe still, bis diese Gruppe freigegeben ist: Führe /telegram:access im Terminal des Agenten aus.',
    privacy: 'Hinweis: Telegram leitet mir hier nur Antworten auf meine eigenen Nachrichten weiter, keine Erwähnungen. ' +
      'Damit ich auf Erwähnungen antworte, mach mich zum Admin dieser Gruppe.',
    botfather: '(Oder schalte Group Privacy in @BotFather → Bot Settings aus, entferne mich dann aus der Gruppe und füge mich wieder hinzu.)',
  },
  fr: {
    // Worded so no past participle agrees with the agent: its gender is unknown.
    hello: hello((n) => `Bonjour, je suis ${n}.`,
      'Pour me poser une question, répondez à l’un de mes messages.',
      'Je ne réponds qu’à la personne qui m’a fait entrer dans ce groupe.',
      'Je réponds aux messages de ce groupe.',
      'Appelez-moi par mon nom quand vous avez besoin de moi.'),
    added: (t, id) => `Bonjour ! Je viens d’arriver dans « ${t} » — id du groupe : ${id}.`,
    waitApp: (n) => `Je ne dirai rien tant que mon propriétaire n’aura pas approuvé ce groupe dans l’app 5dive (réglages de l’agent → « Qui peut parler à l’agent ${n} »).`,
    waitTerminal: 'Je ne dirai rien tant que ce groupe n’est pas approuvé : lancez /telegram:access dans le terminal de l’agent.',
    privacy: 'À savoir : ici, Telegram ne me transmet que les réponses à mes propres messages, pas les mentions. ' +
      'Pour que je réponde quand on me mentionne, faites de moi un administrateur de ce groupe.',
    botfather: '(Ou désactivez Group Privacy dans @BotFather → Bot Settings, puis retirez-moi du groupe et ajoutez-moi de nouveau.)',
  },
  ja: {
    hello: (name, replyOnly = false, everyMessage = false, ownerOnly = false) =>
      `こんにちは、${name}です。` +
      (replyOnly ? '質問するときは、私のメッセージのどれかに返信してください。'
        : ownerOnly ? '私を追加した人にだけ返信します。'
        : everyMessage ? 'このグループのメッセージに返信します。'
        : '用があるときは名前で呼んでください。'),
    added: (t, id) => `こんにちは！「${t}」に追加されました — グループID：${id}。`,
    waitApp: (n) => `オーナーが 5dive アプリでこのグループを承認するまで、ここでは発言しません（エージェントの設定 → 「エージェント${n}に話しかけられる人」）。`,
    waitTerminal: 'このグループが承認されるまで発言しません。エージェントのターミナルで /telegram:access を実行してください。',
    privacy: 'ご注意：ここでは Telegram は私のメッセージへの返信だけを届け、メンションは届けません。メンションに応答できるよう、私をこのグループの管理者にしてください。',
    botfather: '（または @BotFather → Bot Settings で Group Privacy をオフにしてから、私をグループから削除して追加し直してください。）',
  },
  ko: {
    hello: hello((n) => `안녕하세요, ${n}입니다.`,
      '질문하려면 제 메시지 중 하나에 답장해 주세요.',
      '저를 추가한 사람에게만 답합니다.',
      '이 그룹의 메시지에 답합니다.',
      '필요할 때 제 이름을 불러 주세요.'),
    added: (t, id) => `안녕하세요! "${t}" 그룹에 추가되었습니다 — 그룹 ID: ${id}.`,
    waitApp: (n) => `소유자가 5dive 앱에서 이 그룹을 승인할 때까지 조용히 있겠습니다(에이전트 설정 → "${n} 에이전트와 대화할 수 있는 사람").`,
    waitTerminal: '이 그룹이 승인될 때까지 조용히 있겠습니다. 에이전트 터미널에서 /telegram:access를 실행해 주세요.',
    privacy: '참고: 여기서 Telegram은 제 메시지에 대한 답장만 전달하고 멘션은 전달하지 않습니다. 멘션에 답하려면 저를 이 그룹의 관리자로 지정해 주세요.',
    botfather: '(또는 @BotFather → Bot Settings에서 Group Privacy를 끈 다음, 저를 그룹에서 내보냈다가 다시 추가해 주세요.)',
  },
}

export type JoinInput = {
  lite: boolean
  lang: Lang
  /** DIVE-8513: the adder's raw Telegram language_code. The default profile
   *  speaks it (every app language, joinLang); absent, it follows `lang`. */
  code?: string | null
  /** The bot's display name (getMe first_name), else its username. */
  name: string
  username: string
  title: string
  chatId: string
  /** Approved just now because the owner added it. */
  approved: boolean
  /** Not approved and never announced: the one-time waiting line. */
  announce: boolean
  /** Non-admin with BotFather's Group Privacy on (DIVE-246). */
  privacyOn: boolean
  /** DIVE-6675: the group answers every message, not only when she is called by name. */
  everyMessage?: boolean
  /** DIVE-7250: the group answers its owners only. */
  ownerOnly?: boolean
  /** A 5dive host (the app exists); else the OSS /telegram:access pointer. */
  fivedive: boolean
}

export function groupJoinLines(i: JoinInput): string[] {
  const lines: string[] = []
  if (i.lite) {
    const s = GROUP_STRINGS[i.lang]
    if (i.approved) lines.push(s.hello(i.name, i.privacyOn, i.everyMessage, i.ownerOnly))
    else if (i.announce) lines.push(s.waiting(i.name))
    if (i.privacyOn) lines.push(s.privacy)
    return lines
  }
  const s = JOIN_STRINGS[joinLang(i.code ?? i.lang)]
  if (i.approved) lines.push(`👋 ${s.hello(i.name, i.privacyOn, i.everyMessage, i.ownerOnly)}`)
  else if (i.announce) {
    lines.push(`👋 ${s.added(i.title, i.chatId)} ${i.fivedive ? s.waitApp(i.name) : s.waitTerminal}`)
  }
  // DIVE-246, in plain words. DIVE-5454: with privacy on and no admin rights a
  // mention never arrives, so this is how a mention-only group starts working.
  if (i.privacyOn) lines.push(`⚠️ ${s.privacy} ${s.botfather}`)
  return lines
}
