/**
 * 五段式 cron 的最小实现：分 时 日 月 周。
 * 支持星号、数字、列表 a,b、区间 a-b，以及带步长的 `星号/n` 与 `a-b/n`。
 * 两个能力：调度器每分钟问一次的匹配判断，和给人看的「下次触发时间」推算。
 * 两者共用同一个日期判据、同一个本地时区，绝不会出现「卡片说九点、调度器十点才跑」。
 */

interface CronField {
  min: number;
  max: number;
  values: Set<number>;
}

const FIELD_RANGES: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // 分
  { min: 0, max: 23 }, // 时
  { min: 1, max: 31 }, // 日
  { min: 1, max: 12 }, // 月
  { min: 0, max: 6 }, // 周（0 = 周日）
];

/**
 * 推算下一次触发时最多往后翻多少天。
 * 取 9 年而不是常见的 4 年：`* * 29 2 *` 通常四年一遇，但世纪年不闰，
 * 2096-03-01 之后要一直等到 2104-02-29，中间隔了整整 8 年。
 * 上界之内没找到就如实返回「算不出」——2 月 30 日这种永不命中的组合
 * 必须在有限步内收敛，不能让调用方挂在一个空转的循环里。
 */
const MAX_SEARCH_DAYS = 366 * 9;

function parseField(expression: string, min: number, max: number): CronField {
  const values = new Set<number>();
  for (const part of expression.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    if (rangePart === undefined) throw new Error(`cron 字段无法解析: ${part}`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`cron 步长必须是正整数: ${part}`);
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [from, to] = rangePart.split("-");
      start = Number(from);
      end = Number(to);
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : max;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`cron 字段无法解析: ${part}`);
    }
    if (start < min || end > max || start > end) {
      throw new Error(`cron 字段超出范围 ${min}-${max}: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (!values.size) throw new Error(`cron 字段为空: ${expression}`);
  return { min, max, values };
}

export interface CronExpression {
  readonly source: string;
  matches(date: Date): boolean;
  /**
   * 严格晚于 `after` 的下一次触发时刻；上界内不命中则返回 undefined。
   * `after` 的秒与毫秒不参与判断：调度器只看得到分钟粒度，
   * 起点带秒的话「严格晚于」会漂回同一分钟里去。
   */
  nextRun(after: Date): Date | undefined;
}

export function parseCron(source: string): CronExpression {
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式需要 5 个字段（分 时 日 月 周），收到: ${source}`);
  }
  const fields = parts.map((part, index) => {
    const range = FIELD_RANGES[index]!;
    return parseField(part!, range.min, range.max);
  });
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    CronField,
    CronField,
    CronField,
    CronField,
    CronField,
  ];

  /**
   * 「这一天算不算数」：月 + 日/周。只看日期，不看钟点。
   * matches 与 nextRun 都走这一个判据——日与周的「或」语义只能有一份实现，
   * 复制一份出去就等于允许卡片上的时间和调度器实际跑的时间各说各话。
   */
  const matchesDate = (date: Date): boolean => {
    if (!month.values.has(date.getMonth() + 1)) return false;
    // 与标准 cron 一致：日和周都被限定时取「或」。
    const dayOfMonthRestricted = dayOfMonth.values.size !== 31;
    const dayOfWeekRestricted = dayOfWeek.values.size !== 7;
    const dayOfMonthHit = dayOfMonth.values.has(date.getDate());
    const dayOfWeekHit = dayOfWeek.values.has(date.getDay());
    if (dayOfMonthRestricted && dayOfWeekRestricted) {
      return dayOfMonthHit || dayOfWeekHit;
    }
    return dayOfMonthHit && dayOfWeekHit;
  };

  const ascending = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);
  const hours = ascending(hour.values);
  const minutes = ascending(minute.values);

  const expression: CronExpression = {
    source: parts.join(" "),
    matches(date: Date): boolean {
      if (!minute.values.has(date.getMinutes())) return false;
      if (!hour.values.has(date.getHours())) return false;
      return matchesDate(date);
    },
    nextRun(after: Date): Date | undefined {
      // 起点的下一分钟。抹掉秒与毫秒：09:30:45 时 09:30:00 已经过去了，
      // 不抹的话会把一个早于起点的时刻当成「下一次」发出去。
      const cursor = new Date(
        after.getFullYear(),
        after.getMonth(),
        after.getDate(),
        after.getHours(),
        after.getMinutes() + 1,
      );
      if (Number.isNaN(cursor.getTime())) return undefined;

      // 逐天推进，而不是逐分钟：分钟级扫 9 年是 470 万次判断，按天只有三千多次。
      let day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
      for (let step = 0; step < MAX_SEARCH_DAYS; step += 1) {
        if (matchesDate(day)) {
          for (const h of hours) {
            for (const m of minutes) {
              const candidate = new Date(
                day.getFullYear(),
                day.getMonth(),
                day.getDate(),
                h,
                m,
              );
              if (candidate.getTime() < cursor.getTime()) continue;
              // 夏令时会让本地某一小时整段不存在，Date 会把它顺延到别的钟点。
              // 顺延后的时刻不是这条 cron 该触发的时刻，所以出门前再过一遍 matches：
              // 「算出来的时刻拿去做匹配判断必然为真」这条不变量由这一句兜底。
              if (!expression.matches(candidate)) continue;
              return candidate;
            }
          }
        }
        // 用「日 + 1」而不是加 24 小时：夏令时那天不是 24 小时，加毫秒会漏掉或重复一天。
        day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      }
      return undefined;
    },
  };
  return expression;
}

export function isValidCron(source: string): boolean {
  try {
    parseCron(source);
    return true;
  } catch {
    return false;
  }
}
