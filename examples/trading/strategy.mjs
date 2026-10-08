// Illustrative stock-bar signal rule, not an alpha or profitability claim.
// One result per input bar. Ten-bar warm-up and halts produce aligned nulls.
export function runStrategy(bars) {
  return bars.map((bar, index) => {
    if (index < 9 || bar.halted) return null;
    const known = bars.slice(index - 9, index + 1);
    const mean = known.reduce((sum, b) => sum + b.price, 0) / known.length;
    return bar.price >= mean ? 'buy' : 'sell';
  });
}

// Deliberately wrong: a future-dependent threshold for the mutation example.
export function futureDependentStrategy(bars) {
  const futureMean = bars.reduce((sum, b) => sum + b.price, 0) / bars.length;
  return bars.map((bar, index) => index < 9 || bar.halted ? null : bar.price >= futureMean ? 'buy' : 'sell');
}
