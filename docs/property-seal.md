# Mandatory Property code gates

Orca uses its shared Property parser and mapped generators/corpus to derive
current contracts for Seal. At gate-code it invokes the real local test runner
and reruns each recorded isolated production mutation. Cached status strings do
not authorize a PASS. Actual execution and probe reports are retained under the
change's `.harness/property-gate/` directory.

Generate each mutation receipt with `orca property-probe <change> --property <id>
--mutation <file>`. If source, test, generator, corpus, runner or contract changes,
regenerate receipts; stale bindings block. Missing, invalid, unavailable and
surviving mutants block mandatory Properties. Syntax or setup errors are not kills.

A survivor may be reviewed using the existing independent operator signature
workflow. Reviewer keys remain outside the project. Seal still requires at least
one meaningful kill: equivalent-only evidence cannot pass. Ordinary Scenario
gates and plan review retain their behavior. Mandatory Property gates reject an
older Seal API explicitly, and an ordinary custom review hook cannot bypass this
policy.

The local candidate carries the exact reviewed Seal tarball in `vendor/` and
bundles that dependency in the Orca package. This permits offline candidate
installation without publishing an unreleased dependency to npm. Registry
publication and replacement of that candidate dependency are separate reviewed
release work. The operator's normal file workflow requires no GitHub account.

The callback is trusted application code, not an OS sandbox. Finite seeded samples
and mutation kills provide executable evidence, not a correctness proof or alpha.
