/**
 * 飞书接入层：WebSocket 长连接收事件 + REST 发消息。
 * 这一层只负责可靠地收进来、发出去，业务判断全部留给 app/。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { withTimeout } from "../core/timeout.js";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { CardJson } from "./card.js";
import {
  extractMessageText,
  parseMentions,
  type Mention,
} from "./message-parser.js";

/** 飞书正文与评论的长度上限，超出会被接口拒绝。 */
export const FEISHU_TEXT_LIMIT = 4_000;
export const FEISHU_COMMENT_LIMIT = 1_000;

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  text: string;
  rootId: string;
  threadId: string;
  /** app / bot 表示这条消息来自机器人，用于识别协作派活。 */
  senderType: string;
  senderOpenId: string;
  senderUnionId: string;
  mentions: Mention[];
  /** 原始 content，富媒体 key 还藏在里面。 */
  rawContent: string;
}

export interface CardAction {
  operatorOpenId: string;
  operatorUnionId: string;
  messageId: string;
  /** 这次点击实际发生在哪个群。按钮自带的群 id 只是数据，要拿它来对齐。 */
  chatId: string;
  value: Record<string, unknown>;
  formValue: Record<string, unknown>;
}

export interface CardActionResponse {
  toast?: { type: "success" | "info" | "warning" | "error"; content: string };
  card?: { type: "raw"; data: CardJson };
}

export interface IncomingDocumentComment {
  eventId: string;
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId: string;
  senderOpenId: string;
  senderUnionId: string;
  mentionedBot: boolean;
}

export interface BotIdentity {
  openId: string;
  name: string;
}

export interface Bot {
  client: Lark.Client;
  getIdentity: () => Promise<BotIdentity>;
  reply: (
    messageId: string,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>;
  replyCard: (
    messageId: string,
    card: CardJson,
    replyInThread?: boolean,
  ) => Promise<string | undefined>;
  replyMention: (
    messageId: string,
    target: BotIdentity,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>;
  /**
   * open_id → 显示名。查不到就返回 undefined，调用方退化成 id 前缀，不要当成错误。
   */
  resolveUserName: (openId: string) => Promise<string | undefined>;
  /** 在群里新开一个话题（发送根消息），定时任务派活用它。 */
  createThread: (chatId: string, text: string) => Promise<string | undefined>;
  updateCard: (messageId: string, card: CardJson) => Promise<void>;
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    saveDir: string,
    fileName?: string,
  ) => Promise<string>;
  subscribeToDocumentComments: () => Promise<void>;
  replyToDocumentComment: (
    comment: IncomingDocumentComment,
    text: string,
  ) => Promise<void>;
  setDocumentCommentWorking: (
    comment: IncomingDocumentComment,
    active: boolean,
  ) => Promise<void>;
}

export interface BotOptions {
  appId: string;
  appSecret: string;
  onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>;
  onCardAction?: (
    action: CardAction,
  ) => Promise<CardActionResponse | undefined>;
  onDocumentComment?: (
    comment: IncomingDocumentComment,
    bot: Bot,
  ) => Promise<void>;
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function fitFeishuText(text: string, limit = FEISHU_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 12)}\n…（内容过长已截断）`;
}

function getHeader(headers: unknown, name: string): string {
  const source = headers as
    | { get?: (key: string) => unknown }
    | Record<string, unknown>
    | undefined;
  const value =
    typeof (source as { get?: unknown })?.get === "function"
      ? (source as { get: (key: string) => unknown }).get(name)
      : ((source as Record<string, unknown>)?.[name] ??
        (source as Record<string, unknown>)?.[name.toLowerCase()]);
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

function resourceExtension(
  type: "image" | "file",
  fileName: string | undefined,
  contentType: string,
): string {
  const original = fileName ? extname(fileName).slice(1).toLowerCase() : "";
  if (/^[a-z0-9]{1,10}$/.test(original)) return original;
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === "image" ? "img" : "bin");
}

/** 飞书 post 消息的 content 是带语言节点的二维数组，普通文本塞不进去。 */
export function buildMentionPostContent(
  target: BotIdentity,
  text: string,
): Record<string, unknown> {
  return {
    zh_cn: {
      title: "",
      content: [
        [
          {
            tag: "at",
            user_id: target.openId,
            ...(target.name ? { user_name: target.name } : {}),
          },
          { tag: "text", text: ` ${fitFeishuText(text)}` },
        ],
      ],
    },
  };
}

export function parseCardAction(data: unknown): CardAction {
  const event = (data ?? {}) as Record<string, any>;
  const value = event.action?.value;
  const formValue = event.action?.form_value;
  return {
    operatorOpenId: event.operator?.open_id ?? event.operator_id?.open_id ?? "",
    operatorUnionId:
      event.operator?.union_id ?? event.operator_id?.union_id ?? "",
    messageId: event.context?.open_message_id ?? event.open_message_id ?? "",
    // card.action.trigger 把消息 id 和群 id 一起挂在 context 下，顶层写法只是兜底。
    chatId: event.context?.open_chat_id ?? event.open_chat_id ?? "",
    value: isRecord(value) ? value : {},
    formValue: isRecord(formValue) ? formValue : {},
  };
}

async function fetchBotIdentity(client: Lark.Client): Promise<BotIdentity> {
  const response = (await client.request({
    url: "/open-apis/bot/v3/info",
    method: "GET",
  })) as { bot?: { open_id?: string; app_name?: string } };
  const bot = response?.bot;
  if (!bot?.open_id) throw new Error("飞书没有返回 bot open_id");
  return { openId: bot.open_id, name: bot.app_name?.trim() || "Bot" };
}

async function findRootCommentReplyId(
  client: Lark.Client,
  comment: IncomingDocumentComment,
): Promise<string> {
  const response = await client.drive.v1.fileComment.get({
    path: { file_token: comment.fileToken, comment_id: comment.commentId },
    params: { file_type: comment.fileType as any },
  });
  const replyId = (response.data as any)?.reply_list?.replies?.[0]?.reply_id;
  if (!replyId) throw new Error("找不到评论的根回复 ID");
  return String(replyId);
}

/** 说话的人是有限的，这个上限只是防止异常情况下无限增长。 */
const NAME_CACHE_LIMIT = 500;
/**
 * 查不到名字的负缓存时长。设成有限值是为了「加完权限不用重启」：
 * 应用没有通讯录权限时接口照样返回成功、只是不含 name 字段，
 * 永久缓存的话你在后台补了权限也看不到变化，只会以为功能坏了。
 */
const NAME_MISS_TTL_MS = 10 * 60_000;
/**
 * Lark.Client 自己不设超时。查显示名是「锦上添花」，绝不能因为网络劣化
 * 把整轮任务卡在起跑线上——拿不到名字只是卡片上少个称呼。
 */
const NAME_LOOKUP_TIMEOUT_MS = 3_000;
/**
 * 出站调用的时限。同样是因为 Lark.Client 没有超时：网络劣化时一次
 * reply / updateCard 会永远挂着，把整轮任务卡在收尾上。
 * 2026-08-25 真实发生过——任务 20:48 就判了失败并记了日志，会话直到 22:16
 * 才释放，中间隔了 88 分钟，横跨一场持续的飞书网络故障。
 * 到点只是不再等，请求本身可能仍然成功：卡片刷新无所谓（下一次覆盖它），
 * reply 最坏丢掉一个 message id，都远好过把会话永久占住。
 */
const FEISHU_CALL_TIMEOUT_MS = 20_000;

/** 下载可能是几十兆的文件，给它和普通调用完全不同的量级。 */
const FEISHU_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function withTimeoutOf<A extends unknown[], R>(
  label: string,
  ms: number,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => withTimeout(fn(...args), ms, `飞书${label}`);
}

function withCallTimeout<A extends unknown[], R>(
  label: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => withTimeout(fn(...args), FEISHU_CALL_TIMEOUT_MS, `飞书${label}`);
}


/**
 * 长连接的配置。**这里现在是空的，而且是有意的。**
 *
 * 8/27 我给它开了两个 SDK 默认关着的开关，理由是「文档说开着更安全」。
 * 真机跑了四天，两个都被证伪：
 *
 * - `handshakeTimeoutMs: 15000` —— 握手超时后 SDK 在定时器里调 `terminate()`，
 *   `ws` 抛出的 "WebSocket was closed before the connection was established"
 *   没人接，一路冒到顶把进程带走。**部署前 0 次，部署后 7 次崩溃**，
 *   pm2 重启次数从 11 涨到 24。它防的是一个我从没见过的问题（握手无限挂住），
 *   代价是一个真实发生了 7 次的问题。
 * - `wsConfig.pingTimeout: 300` —— 重连率从 5.5 次/小时涨到 10.8 次/小时，
 *   翻了一倍。当时注释里就写了「服务端 ping 周期我们并不知道，设短了会造成
 *   本来没必要的重连，这是第一个该回头看的旋钮」——回头看了，就是它。
 *
 * 教训不是「这两个开关不好」，是**我读了文档就当验证过了**。
 * 文档说的是这个选项做什么，没说它出错时谁来接、也没说它在这个网络上会多灵敏。
 * 要再开，先在真机上盯着崩溃数和重连率跑几天，别再靠推断。
 */
export const WS_RESILIENCE = {} as const;

export function startBot(opts: BotOptions): Bot {
  const { appId, appSecret, onMessage, onCardAction, onDocumentComment } = opts;
  const client = new Lark.Client({ appId, appSecret });
  // 飞书的消息事件只带 open_id，不带显示名，要显示成人名只能查通讯录。
  // 命中和未命中都要缓存：没有通讯录权限时接口会「成功但不返回 name」，
  // 不缓存的话每条消息都会白打一次接口。
  const nameCache = new Map<string, { name?: string; at: number }>();

  const bot: Bot = {
    client,

    async resolveUserName(openId) {
      if (!openId) return undefined;
      const hit = nameCache.get(openId);
      // 查到过的名字一直用；没查到的过一段时间再试一次，好让新加的权限自己生效
      if (hit && (hit.name || Date.now() - hit.at < NAME_MISS_TTL_MS)) {
        return hit.name;
      }
      let name: string | undefined;
      try {
        const res = await withTimeout(
          client.contact.user.batch({
            params: { user_ids: [openId], user_id_type: "open_id" },
          }),
          NAME_LOOKUP_TIMEOUT_MS,
        );
        name = res?.data?.items?.[0]?.name || undefined;
      } catch (error) {
        // 查显示名失败不是任务失败：记一笔，让调用方退化成 id 前缀继续跑
        console.warn(
          `[通讯录] 查显示名失败 ${openId.slice(0, 12)}…：${(error as Error).message}`,
        );
      }
      if (nameCache.size >= NAME_CACHE_LIMIT) {
        const oldest = nameCache.keys().next().value;
        if (oldest) nameCache.delete(oldest);
      }
      nameCache.set(openId, { at: Date.now(), ...(name ? { name } : {}) });
      return name;
    },

    getIdentity() {
      return fetchBotIdentity(client);
    },

    async reply(messageId, text, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: fitFeishuText(text) }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },

    async replyCard(messageId, card, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      // 返回的是卡片自己的 message_id，后续所有进度都更新它。
      return res.data?.message_id;
    },

    async replyMention(messageId, target, text, replyInThread = false) {
      // 更新已发出的卡片不会触发 @提及通知，必须发一条新消息才能真正点到人。
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "post",
          content: JSON.stringify(buildMentionPostContent(target, text)),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },

    async createThread(chatId, text) {
      const res = await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: fitFeishuText(text) }),
        },
      });
      return res.data?.message_id;
    },

    async updateCard(messageId, card) {
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    },

    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      const contentType = getHeader((res as any).headers, "content-type");
      const extension = resourceExtension(type, fileName, contentType);
      const savePath = join(saveDir, `${fileKey}.${extension}`);
      await mkdir(saveDir, { recursive: true });
      await (res as any).writeFile(savePath);
      return savePath;
    },

    async subscribeToDocumentComments() {
      const response = await client.drive.v1.user.subscription({
        data: { event_type: "drive.notice.comment_add_v1" as any },
      });
      if (response.code && response.code !== 0) {
        throw new Error(response.msg || "订阅飞书文档评论事件失败");
      }
    },

    async replyToDocumentComment(comment, text) {
      const response = await client.drive.v1.fileCommentReply.create({
        path: { file_token: comment.fileToken, comment_id: comment.commentId },
        params: {
          file_type: comment.fileType as any,
          user_id_type: "open_id",
        },
        data: {
          content: {
            elements: [
              {
                type: "text_run",
                text_run: { text: fitFeishuText(text, FEISHU_COMMENT_LIMIT) },
              },
            ],
          },
        },
      });
      if (response.code && response.code !== 0) {
        throw new Error(response.msg || "回复飞书文档评论失败");
      }
    },

    async setDocumentCommentWorking(comment, active) {
      const replyId =
        comment.replyId || (await findRootCommentReplyId(client, comment));
      const response = await client.drive.v2.commentReaction.updateReaction({
        path: { file_token: comment.fileToken },
        params: { file_type: comment.fileType as any },
        data: {
          action: active ? "add" : "delete",
          reply_id: replyId,
          reaction_type: "Typing",
        } as any,
      });
      if (response.code && response.code !== 0) {
        throw new Error(response.msg || "更新飞书文档评论状态失败");
      }
    },
  };

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      const m = data.message;
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractMessageText(m.message_type, m.content),
        rootId: m.root_id ?? "",
        threadId: m.thread_id ?? "",
        senderType: data.sender?.sender_type ?? "",
        senderOpenId: data.sender?.sender_id?.open_id ?? "",
        senderUnionId: data.sender?.sender_id?.union_id ?? "",
        mentions: parseMentions(m.mentions),
        rawContent: m.content,
      };
      await onMessage(msg, bot);
    },

    "card.action.trigger": async (data: any) => {
      if (!onCardAction) return undefined;
      const response = await onCardAction(parseCardAction(data));
      return response ?? {};
    },

    // 只为消噪：机器人被拉进群时飞书会推这个事件，不注册的话 SDK 每次都告警，
    // 真正需要关注的 warn 会被淹掉。
    "im.chat.member.bot.added_v1": async () => undefined,

    "drive.notice.comment_add_v1": async (data: any) => {
      if (!onDocumentComment) return;
      const meta = data.notice_meta;
      if (!meta?.file_token || !meta.file_type || !data.comment_id) return;
      await onDocumentComment(
        {
          eventId: data.event_id ?? "",
          fileToken: meta.file_token,
          fileType: meta.file_type,
          commentId: data.comment_id,
          replyId: data.reply_id ?? "",
          senderOpenId: meta.from_user_id?.open_id ?? "",
          senderUnionId: meta.from_user_id?.union_id ?? "",
          mentionedBot: data.is_mentioned ?? false,
        },
        bot,
      );
    },
  } as any);

  const wsClient = new Lark.WSClient({ appId, appSecret, ...WS_RESILIENCE });
  wsClient.start({ eventDispatcher: dispatcher });

  // 出站调用统一套上时限。downloadResource 故意不套：大文件本来就慢，
  // 给它一刀切的 20 秒只会把正常的下载判成失败。
  bot.reply = withCallTimeout("回复消息", bot.reply);
  bot.replyCard = withCallTimeout("回复卡片", bot.replyCard);
  bot.replyMention = withCallTimeout("回复并@人", bot.replyMention);
  bot.createThread = withCallTimeout("新建话题", bot.createThread);
  bot.updateCard = withCallTimeout("刷新卡片", bot.updateCard);
  // 下载给宽松得多的时限：大文件本来就慢，20 秒会把正常下载判成失败。
  // 但不能不设——无界等待正是这次要修的那一类问题。
  bot.downloadResource = withTimeoutOf(
    "下载文件",
    FEISHU_DOWNLOAD_TIMEOUT_MS,
    bot.downloadResource,
  );

  return bot;
}
