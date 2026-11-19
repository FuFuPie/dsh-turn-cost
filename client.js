/**
 * Client half: a compact `¥0.082` chip inside the finished-message action row,
 * placed immediately before the shipped `用量 … tok` readout.
 *
 * The Conversation layer already folds every Turn's provider-reported usage
 * into exact buckets and publishes them on the `turn-tail` Location data, so
 * this module never re-reads the session log: it only prices what is there.
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
     * 高峰时段：北京时间周一至周五 09:00-12:00、14:00-18:00；其余（含周末）为
     * 空闲时段，单价减半。法定节假日未建模，节假日会按高峰价计算。
     */
    function isPeak(timeMs) {
      const stamp = Number(timeMs);
      const utc8 = new Date((Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now()) + BEIJING_OFFSET_MS);
      const day = utc8.getUTCDay();
      if (day === 0 || day === 6) return false;
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
      const miss = Math.max(0, Number(usage.uncachedInputTokens) || 0);
      const hit = Math.max(0, Number(usage.cacheReadTokens) || 0);
      const write = Math.max(0, Number(usage.cacheWriteTokens) || 0);
      const out = Math.max(0, Number(usage.outputTokens) || 0);
      if (miss + hit + write + out <= 0) return null;
      const peak = isPeak(tail.time);
      const price = PRICES[FALLBACK_MODEL];
      const index = peak ? 1 : 0;
      const cost = ((hit * price.hit[index]) + ((miss + write) * price.miss[index]) + (out * price.out[index])) / 1e6;
      const detail = [
        '本轮 ' + formatCny(cost) + ' · ' + (peak ? '高峰价' : '空闲价') + ' · ' + FALLBACK_MODEL,
        '输入 ' + formatTokens(miss) + ' · 缓存命中 ' + formatTokens(hit) + ' · 输出 ' + formatTokens(out),
        '合计 ' + formatTokens(miss + hit + write + out) + ' tok',
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

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'dsh-turn-cost',
          order: 999,
        }, TurnCost));
      },
    };
  },
});
