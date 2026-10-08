# Seeded no-lookahead example

Run from this directory with a Git checkout, local Vitest and the current Orca
package available to test imports:

```sh
orca verify no-lookahead
```

For a separate project, copy this directory, initialize Git, install Vitest and
the local Orca package, and run verification. A real strategy requires its own
approved intent/domain policy; this example is not trading deployment approval.

The illustrative rule has ten-bar warm-up and returns one result per input bar.
Halted bars produce aligned nulls. Tail timestamps begin after the retained
prefix. The domain accepts positive stock prices and nonnegative volume; it
does not silently treat NaN or negative futures/spread prices as valid stocks.

The bundled concrete corpus was captured from `futureDependentStrategy`, which
deliberately uses future bars. Correct code replays that case before running
1000 seeded generated inputs. Keep corpus data when the generator changes.
This checks logic, not profitability or alpha.
