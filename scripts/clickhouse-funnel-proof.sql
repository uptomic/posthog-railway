-- Synthetic constants only. Mirrors funnel-udf/src/e2e_tests.rs at the locked
-- upstream revision; never reads production events or changes a saved insight.
WITH aggregate_funnel(
    toUInt8(3), toUInt64(3600), 'first_touch', 'ordered',
    CAST(['FixtureBrowser'], 'Array(Nullable(String))'),
    CAST([], 'Array(Int8)'),
    CAST([
        (1., toUUID('00000000-0000-0000-0000-000000000001'), 'FixtureBrowser', [1]),
        (2., toUUID('00000000-0000-0000-0000-000000000002'), 'FixtureBrowser', [2]),
        (3., toUUID('00000000-0000-0000-0000-000000000003'), 'FixtureBrowser', [3])
    ], 'Array(Tuple(Nullable(Float64), UUID, Nullable(String), Array(Int8)))')
) AS result
SELECT toUInt8(
    length(result) = 1
    AND result[1].1 = 2
    AND result[1].2 = 'FixtureBrowser'
    AND result[1].3 = [1., 1.]
    -- The UDF intentionally permits repeated copies of a matched event UUID.
    AND arrayMap(events -> arrayDistinct(events), result[1].4) = [
        [toUUID('00000000-0000-0000-0000-000000000001')],
        [toUUID('00000000-0000-0000-0000-000000000002')],
        [toUUID('00000000-0000-0000-0000-000000000003')]
    ]
    AND result[1].5 = 7
)
SETTINGS max_execution_time = 20
FORMAT TabSeparated
