/** 飞书消息体解析：正文提取、@提及还原、富媒体资源 key。 */

export interface Mention {
  /** 正文里的占位符，如 @_user_1 */
  key: string;
  name: string;
  openId: string;
}

interface PostElement {
  tag?: string;
  text?: string;
  user_id?: string;
}

function renderPostElement(element: PostElement): string {
  if (element.tag === "at") return element.user_id ?? "";
  if (element.tag === "br") return "\n";
  // code_block 也要保留：把日志或代码粘成代码块时，正文不能变成空串。
  if (["text", "a", "code", "code_block", "md"].includes(element.tag ?? "")) {
    return element.text ?? "";
  }
  return "";
}

export function extractMessageText(
  messageType: string,
  content: string,
): string {
  // content 是套在事件 JSON 里的 JSON 字符串，必须再 parse 一次。
  const parsed = JSON.parse(content);

  if (messageType === "text") return parsed.text ?? "";

  if (messageType === "post") {
    const paragraphs: PostElement[][] = parsed.content ?? [];
    return paragraphs
      .map((paragraph) => paragraph.map(renderPostElement).join(""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

export function parseMentions(raw: unknown[] | undefined): Mention[] {
  if (!raw?.length) return [];
  return raw.map((item) => {
    const mention = item as {
      key?: string;
      name?: string;
      id?: { open_id?: string };
    };
    return {
      key: mention.key ?? "",
      name: mention.name ?? "",
      openId: mention.id?.open_id ?? "",
    };
  });
}

/**
 * 把 @提及还原成人能读的名字。
 *
 * 实测（text 与 post 都验过）：飞书投递的消息里 at 元素的 user_id 装的是
 * @_user_N 占位符，真实 open_id 在事件的 mentions 数组里。所以靠 key 就够了。
 * 额外按 openId 再替一次只是兜底，防的是某些接口直接给出裸 id 的情况；
 * 因此它要求 name 非空，否则宁可原样留着。
 */
export function resolveMentions(text: string, mentions: Mention[]): string {
  let resolved = text;
  for (const mention of mentions) {
    if (mention.key) {
      resolved = resolved.replaceAll(mention.key, `@${mention.name}`);
    }
    // 没有名字就没什么可还原的，留着原样比换成一个孤零零的 @ 强。
    if (mention.openId && mention.name) {
      resolved = resolved.replaceAll(mention.openId, `@${mention.name}`);
    }
  }
  return resolved.trim();
}

export interface MessageResource {
  type: "image" | "file";
  key: string;
  fileName?: string;
}

export function extractResourceKeys(
  messageType: string,
  content: string,
): MessageResource[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const resources: MessageResource[] = [];

  if (messageType === "image" && typeof parsed.image_key === "string") {
    resources.push({ type: "image", key: parsed.image_key });
  }
  if (messageType === "file" && typeof parsed.file_key === "string") {
    resources.push({
      type: "file",
      key: parsed.file_key,
      ...(typeof parsed.file_name === "string"
        ? { fileName: parsed.file_name }
        : {}),
    });
  }
  if (messageType === "post") {
    // 富文本里也可能内嵌图片。
    const paragraphs = (parsed.content ?? []) as Array<
      Array<{ tag?: string; image_key?: string }>
    >;
    for (const element of paragraphs.flat()) {
      if (element?.tag === "img" && element.image_key) {
        resources.push({ type: "image", key: element.image_key });
      }
    }
  }

  return resources;
}

/**
 * 去掉正文里的 @提及，用来判断这条消息除了 @ 之外还有没有内容。
 *
 * 必须按 mentions 精确剥离，不能用 /@\S+/ 这类正则：
 * 飞书里 @名字 和后面的正文之间可以没有空格，「@agent-os读一下」会被整段吃掉，
 * 有内容的消息就被误判成空任务挡下来了。
 *
 * key 和 openId 都要剥：text 消息里 at 是 @_user_N 占位符，
 * 而 post 消息经 extractMessageText 渲染后留下的是 open_id。
 */
export function stripMentions(text: string, mentions: Mention[]): string {
  let stripped = text;
  for (const mention of mentions) {
    if (mention.key) stripped = stripped.replaceAll(mention.key, "");
    if (mention.openId) stripped = stripped.replaceAll(mention.openId, "");
  }
  return stripped.trim();
}
