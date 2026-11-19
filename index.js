/**
 * Host half of the turn-cost bundle.
 *
 * The cost itself needs no Host work: the Conversation layer already publishes
 * exact per-turn token buckets on the `turn-tail` node, so the Client module
 * only multiplies them by DeepSeek's published unit prices.
 */
export function apply() {}
