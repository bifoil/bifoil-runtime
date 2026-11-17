# Independent runtime capacity controls

These original fixtures test active execution independently of compiler source-volume measurements. They exercise the
current development guards; they do not establish the target source capacity, permanent language limits, or the strict
aggregate compiler memory and incremental-build contract.

## Execution and allocation

[Capacity tests](test/capacity.test.mjs) use two checked-in compiled fixtures:

- [Recursive calls](test/fixtures/capacity-depth.bfl) reach 1,024 live frames, retain every pending addition operand,
  save at the deepest input wait, restore all frames, and unwind to the expected result. The next recursive call
  reports the depth guard with its source location. Further execution, selection, and saving retain that same failure.
- [Long execution](test/fixtures/capacity-execution.bfl) runs 100,000 iterations across repeated 2,048-instruction
  slices. Each iteration creates temporary scopes, cells, and a mutable list. The test checks the independently
  calculated checksum, automatic collection, termination, and bounded retained state.
- A separate active-allocation control roots 100,000 live objects through an outer list and an alias. The next
  allocation fails at the current object guard. Explicit collection preserves every rooted object and both aliases.

These tests execute with Node.js alone. Regeneration uses an explicitly supplied compiler and preserves source inputs:

```sh
uv run --no-project tools/regenerate-fixtures.py /path/to/bifoilc --names capacity-depth capacity-execution
node --test test/capacity.test.mjs
```

## Collector pressure and checkpoint size

[Collector tests](test/collector.test.mjs) independently create and reclaim at least 12,001 dead cells, environments,
and objects while retaining live cycles, aliases, and escaping captures.

[Large graph checkpoints](test/checkpoint-large-graphs.test.mjs) retain a 20,000-node nominal ring, shared payloads,
and root aliases through four checkpoints larger than 8 MiB. Every node and payload is checked after each restore;
explicit collection then reclaims at least 1,000 newly dead cells, environments, and objects. This graph test remains
separate from the call-depth, long-execution, and active-allocation controls.

Run the full suite with the explicit unmodified ChoiceScript engine to include native integration checks:

```sh
CHOICESCRIPT_ENGINE=/path/to/choicescript/web/scene.js node --test test/*.test.mjs
```

These are correctness controls with concrete workloads, rather than peak-memory or elapsed-time acceptance measurements.
