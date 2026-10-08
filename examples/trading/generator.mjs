// Domain: valid positive stock prices, monotonic timestamps and nonnegative
// volume. NaN/negative prices are invalid in this example; futures/spreads need
// a separately stated validity or rejection policy.
function timed(raw, start = 0) {
  let time = start;
  return raw.map(bar => ({ ...bar, time: time += bar.gap ? 86400000 : 60000 }));
}
export function arbInputs(fc) {
  const bar = fc.record({
    price: fc.integer({ min: 1, max: 10000 }),
    volume: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 100000 })),
    gap: fc.boolean(),
    halted: fc.boolean(),
  });
  return fc.record({
    bars: fc.array(bar, { minLength: 50, maxLength: 500 }).map(raw => timed(raw)),
    k: fc.nat(),
    tail: fc.array(bar, { minLength: 1, maxLength: 200 }).map(raw => timed(raw)),
  });
}
export function classifyInputs(input) {
  return [
    ...(input.bars.some(b => b.gap) ? ['gap'] : []),
    ...(input.bars.some(b => b.halted) ? ['halt'] : []),
    ...(input.bars.some(b => b.volume === 0) ? ['zero-volume'] : []),
  ];
}
export function relation(input, strategy) {
  const t = input.k % input.bars.length;
  const prefix = input.bars.slice(0, t + 1);
  const replaced = [...prefix, ...timed(input.tail, prefix.at(-1).time)];
  return JSON.stringify(strategy(input.bars).slice(0, t + 1)) ===
    JSON.stringify(strategy(replaced).slice(0, t + 1));
}
