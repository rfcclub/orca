## ADDED Requirements

### Requirement: No lookahead
The example strategy MUST NOT use data after bar t when deciding at bar t.

#### Property: future-independence
- **FOR ALL** bars: 50–500 valid positive stock-price bars with gaps, halts and zero volume
- **AND** k: nonnegative integer selecting t modulo bars.length
- **AND** tail: 1–200 valid bars replacing all bars after t
- **THEN** aligned signals through t equal the original signals through t
- **RUNS** 1000
- **DISCARDS** <= 0%
- **COVERAGE** gap >= 5%
- **COVERAGE** halt >= 5%
- **COVERAGE** zero-volume >= 5%
