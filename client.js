/**
 * Client half of dsh-turn-cost.
 *
 * Two readouts over the same price table:
 *  - `TurnCost`: a `¥0.031` chip inside the finished-message action row, right
 *    before the shipped `用量 … tok` readout.
 *  - `SessionCost`: a `累计 ¥1.23` chip in the top Session header.
 *
 * Neither re-reads the session log. The Conversation layer already folds each
 * Turn's provider-reported usage into exact buckets on the `turn-tail` Location
 * data, and `@deepseek-ai/dsh-token-meter` keeps a session-wide cumulative
 * `tokenUsage` projection; this module only prices those numbers.
 */
window.__ModuleLoader__.load({
  id: 'dsh-turn-cost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * DeepSeek 官方单价，单位 CNY / 百万 tokens，顺序为 [空闲时段, 高峰时段]。
     * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
     * 改价时只改这张表即可；未列出的模型按 deepseek-flash 计。
     */
    const PRICES = {
      'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
      'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
    };
    const FALLBACK_MODEL = 'deepseek-flash';
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

    /**
     * 中国法定节假日（北京时间，含调休连休的每一天）。官方计费口径里这些天
     * 全天按空闲时段计价，所以它们和周末一样不涨价。
     * 数据来源：国办发明电〔2025〕7号（2026）、国办发明电〔2026〕10号（2027）。
     * 每年国务院发通知后往这里补一年即可；表里没有的年份只会退化成「按星期几算」。
     */
    const HOLIDAYS = new Set([
      // 2026
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
      '2026-10-06', '2026-10-07',
      // 2027
      '2027-01-01', '2027-01-02', '2027-01-03',
      '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
      '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
      '2027-04-03', '2027-04-04', '2027-04-05',
      '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
      '2027-06-09',
      '2027-09-15',
      '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05',
      '2027-10-06', '2027-10-07',
    ]);

    /** 北京时间日期键 `YYYY-MM-DD`，用于查节假日表。 */
    function beijingDayKey(utc8) {
      const month = String(utc8.getUTCMonth() + 1).padStart(2, '0');
      const date = String(utc8.getUTCDate()).padStart(2, '0');
      return utc8.getUTCFullYear() + '-' + month + '-' + date;
    }

    /**
     * 高峰 = 北京时间周一至周五 09:00-12:00、14:00-18:00；其余时段（含周末、
     * 法定节假日与调休连休）按空闲时段计，单价减半。调休上班的周六仍算周末，
     * 与官方口径一致。
     */
    function isPeak(timeMs) {
      const stamp = Number(timeMs);
      const utc8 = new Date((Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now()) + BEIJING_OFFSET_MS);
      const day = utc8.getUTCDay();
      if (day === 0 || day === 6) return false;
      if (HOLIDAYS.has(beijingDayKey(utc8))) return false;
      const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes();
      return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
    }

    function formatTokens(value) {
      const n = Math.max(0, Math.round(Number(value) || 0));
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return String(n);
    }

    function formatCny(value) {
      if (!(value > 0)) return '¥0';
      if (value < 0.01) return '¥' + value.toFixed(4);
      if (value < 0.1) return '¥' + value.toFixed(3);
      return '¥' + value.toFixed(2);
    }

    /** 一组 token 桶。缓存写入按未命中单价计（保守）。 */
    function bucketsOf(usage) {
      return {
        miss: Math.max(0, Number(usage && usage.uncachedInputTokens) || 0),
        hit: Math.max(0, Number(usage && usage.cacheReadTokens) || 0),
        write: Math.max(0, Number(usage && usage.cacheWriteTokens) || 0),
        out: Math.max(0, Number(usage && usage.outputTokens) || 0),
      };
    }

    function tokensOf(buckets) {
      return buckets.miss + buckets.hit + buckets.write + buckets.out;
    }

    /** token 桶 × 单价 → 人民币。 */
    function costOf(buckets, peak) {
      const price = PRICES[FALLBACK_MODEL];
      const index = peak ? 1 : 0;
      return ((buckets.hit * price.hit[index])
        + ((buckets.miss + buckets.write) * price.miss[index])
        + (buckets.out * price.out[index])) / 1e6;
    }

    function breakdownOf(buckets) {
      return '输入 ' + formatTokens(buckets.miss)
        + ' · 缓存命中 ' + formatTokens(buckets.hit)
        + ' · 输出 ' + formatTokens(buckets.out)
        + ' · 合计 ' + formatTokens(tokensOf(buckets)) + ' tok';
    }

    function isChineseUi() {
      try {
        return String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
      } catch (error) {
        return false;
      }
    }

    // #region footer chip

    /**
     * Find the completed Turn whose closing assistant message owns `messageId`.
     * `turn-tail` is the Conversation-owned summary of that Turn, including the
     * exact token buckets; absent while the Turn is still open.
     */
    function tailOf(snapshot, messageId) {
      if (messageId === undefined || messageId === null) return undefined;
      const turns = snapshot && snapshot.timeline && snapshot.timeline.turns;
      if (!turns || typeof turns.values !== 'function') return undefined;
      for (const turn of turns.values()) {
        const store = turn && turn.data;
        if (!store || typeof store.get !== 'function') continue;
        const tail = store.get('turn-tail');
        if (!tail || !tail.closing || !tail.closing.finalNode) continue;
        if (tail.closing.finalNode.messageId === messageId) return tail;
      }
      return undefined;
    }

    function TurnCost(props) {
      const messageId = props && props.messageId;
      const useChat = props && props.useChat;
      const tail = typeof useChat === 'function' ? useChat((snapshot) => tailOf(snapshot, messageId)) : undefined;
      const usage = tail && tail.tokenUsage;
      if (!usage) return null;
      const buckets = bucketsOf(usage);
      if (tokensOf(buckets) <= 0) return null;
      const peak = isPeak(tail.time);
      const cost = costOf(buckets, peak);
      const detail = [
        '本轮 ' + formatCny(cost) + ' · ' + (peak ? '高峰价' : '空闲价') + ' · ' + FALLBACK_MODEL,
        breakdownOf(buckets),
      ].join('\n');
      return h('span', {
        title: detail,
        'data-turn-cost': String(cost),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          height: '28px',
          padding: '0 6px',
          fontVariantNumeric: 'tabular-nums',
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-tertiary)',
          cursor: 'help',
          userSelect: 'none',
        },
      }, formatCny(cost));
    }

    // #endregion

    // #region header total

    /**
     * Session total: every completed Turn priced at its own moment (so a session
     * that crosses 12:00 or 18:00 stays honest), plus whatever the session-wide
     * `tokenUsage` projection holds beyond them — the Turn still running — priced
     * at the current moment.
     */
    function SessionCost(props) {
      const useProjection = props && props.useProjection;
      const useChat = props && props.useChat;
      const cumulative = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
      if (!cumulative) return null;
      const all = bucketsOf(cumulative);
      if (tokensOf(all) <= 0) return null;
      const turns = typeof useChat === 'function'
        ? useChat((snapshot) => (snapshot && snapshot.timeline ? snapshot.timeline.turns : undefined))
        : undefined;
      let cost = 0;
      let rounds = 0;
      const done = { miss: 0, hit: 0, write: 0, out: 0 };
      if (turns && typeof turns.values === 'function') {
        for (const turn of turns.values()) {
          const store = turn && turn.data;
          if (!store || typeof store.get !== 'function') continue;
          const tail = store.get('turn-tail');
          const usage = tail && tail.tokenUsage;
          if (!usage) continue;
          const buckets = bucketsOf(usage);
          done.miss += buckets.miss;
          done.hit += buckets.hit;
          done.write += buckets.write;
          done.out += buckets.out;
          cost += costOf(buckets, isPeak(tail.time));
          rounds += 1;
        }
      }
      const rest = {
        miss: Math.max(0, all.miss - done.miss),
        hit: Math.max(0, all.hit - done.hit),
        write: Math.max(0, all.write - done.write),
        out: Math.max(0, all.out - done.out),
      };
      cost += costOf(rest, isPeak(Date.now()));
      const label = isChineseUi() ? '累计' : 'total';
      const detail = [
        '本次会话累计 ' + formatCny(cost) + ' · ' + FALLBACK_MODEL + ' 单价',
        breakdownOf(all),
        '已完成 ' + rounds + ' 轮' + (tokensOf(rest) > 0 ? '，进行中的本轮按当前时段计价' : ''),
      ].join('\n');
      return h('span', {
        title: detail,
        'data-session-cost': String(cost),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          height: '28px',
          padding: '0 6px',
          fontVariantNumeric: 'tabular-nums',
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-tertiary)',
          cursor: 'help',
          userSelect: 'none',
        },
      }, label + ' ' + formatCny(cost));
    }

    // #endregion

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'dsh-turn-cost',
          order: 999,
        }, TurnCost));
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-turn-cost',
          order: 50,
        }, SessionCost));
      },
    };
  },
});
